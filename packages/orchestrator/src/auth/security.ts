import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { authAttempts, authTokens, operators, sessions, type OperatorRow } from '../db/schema.js';
import { ApiError } from './rbac.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { normalizeEmail } from './ratelimit.js';
import { createSession, hashToken, SESSION_COOKIE, sessionCookieOptions, toPgTimestamp } from './sessions.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { withBillingTransaction } from '../billing/transaction.js';
import { writeAudit } from '../audit.js';
import { queueNotification } from '../notifications/service.js';
import { newTotpSecret, totpCounter } from './totp.js';

export async function securityLimit(db: Db, key: string, max = 6, windowMs = 600_000): Promise<void> {
  const now = toPgTimestamp(new Date());
  const expiry = toPgTimestamp(new Date(Date.now() + windowMs));
  const [row] = await db.orm.insert(authAttempts).values({ key: hashToken(key), count: 1, expiresAt: expiry })
    .onConflictDoUpdate({ target: authAttempts.key, set: {
      count: sql`CASE WHEN ${authAttempts.expiresAt} <= ${now}::timestamp THEN 1 ELSE ${authAttempts.count} + 1 END`,
      expiresAt: sql`CASE WHEN ${authAttempts.expiresAt} <= ${now}::timestamp THEN ${expiry}::timestamp ELSE ${authAttempts.expiresAt} END`,
    } }).returning();
  if (row!.count > max) throw new ApiError(429, '操作过于频繁，请稍后重试');
}

export function accountMailReady(config: Config): boolean {
  return !!(config.smtp && config.publicUrl && config.secretKey);
}

export async function issueAccountToken(db: Db, operatorId: number, purpose: string, minutes: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.orm.delete(authTokens).where(and(eq(authTokens.operatorId, operatorId), eq(authTokens.purpose, purpose)));
  await db.orm.insert(authTokens).values({ tokenHash: hashToken(token), operatorId, purpose,
    expiresAt: toPgTimestamp(new Date(Date.now() + minutes * 60_000)),
  });
  return token;
}

export async function queueAccountMail(db: Db, config: Config, op: OperatorRow, purpose: 'verify' | 'reset'): Promise<void> {
  if (!accountMailReady(config)) throw new ApiError(503, '账号邮件服务尚未配置，请联系管理员');
  await withBillingTransaction(db, op.id, async tx => {
    const token = await issueAccountToken(tx, op.id, purpose, 30);
    // Fragment keeps the token out of reverse-proxy request logs and Referer headers.
    const link = `${config.publicUrl}/account-recovery#${purpose}=${token}`;
    const subject = purpose === 'verify' ? '验证您的邮箱' : '重置您的登录密码';
    await queueNotification(tx, config, { operatorId: op.id, category: 'security', key: `auth:${hashToken(token)}`,
      subject, body: `${subject}邮件已申请。链接 30 分钟内有效。`,
      privateMail: `${subject}\n\n${link}\n\n链接 30 分钟内有效且仅能使用一次。若非本人操作，请忽略。`,
      expiresAt: toPgTimestamp(new Date(Date.now() + 1_800_000)),
    });
  });
}

/** Caller holds the operator row lock, so TOTP/recovery codes can be consumed only once. */
export async function consumeMfa(db: Db, config: Config, op: OperatorRow, code: string): Promise<void> {
  if (!op.mfaSecret) return;
  if (!config.secretKey) throw new ApiError(503, '二次验证服务不可用');
  const secret = decryptSecret(op.mfaSecret, config.secretKey);
  const counter = totpCounter(secret, code, op.mfaLastCounter);
  if (counter !== null) {
    await db.orm.update(operators).set({ mfaLastCounter: counter }).where(eq(operators.id, op.id));
    return;
  }
  const hash = hashToken(code.trim().toLowerCase().replace(/\s/g, ''));
  if (!op.mfaRecoveryHashes.includes(hash)) throw new ApiError(400, '验证码无效、已使用或已过期');
  await db.orm.update(operators).set({ mfaRecoveryHashes: op.mfaRecoveryHashes.filter(x => x !== hash) }).where(eq(operators.id, op.id));
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, '请检查输入内容');
  return result.data;
}

export function registerSecurityRoutes(app: FastifyInstance, deps: { db: Db; config: Config }): void {
  const { db, config } = deps;
  const owner = (req: FastifyRequest): number => {
    if (!req.ctx) throw new ApiError(401, '请登录');
    return req.ctx.operatorId;
  };
  const getOperator = async (tx: Db, id: number): Promise<OperatorRow> => {
    const [op] = await tx.orm.select().from(operators).where(eq(operators.id, id));
    if (!op || op.status !== 'active') throw new ApiError(401, '账号不可用');
    return op;
  };
  const passwordProof = z.object({ password: z.string().min(1).max(1024), code: z.string().max(64).default('') });
  async function reauth(req: FastifyRequest, action: string, run: (tx: Db, op: OperatorRow, code: string) => Promise<unknown>): Promise<unknown> {
    const id = owner(req);
    const body = parse(passwordProof, req.body);
    await securityLimit(db, `sensitive:${id}`, 10);
    return withBillingTransaction(db, id, async tx => {
      const op = await getOperator(tx, id);
      if (!await verifyPassword(body.password, op.passwordHash)) throw new ApiError(400, '当前密码错误');
      const result = await run(tx, op, body.code ?? '');
      await writeAudit(tx, { actor: op.email, action, ok: true });
      return result;
    });
  }

  app.post('/api/auth/recovery/request', async req => {
    const body = parse(z.object({ email: z.string().email().max(254), purpose: z.enum(['reset', 'verify']) }), req.body);
    const email = normalizeEmail(body.email);
    // Per-email limit cannot be evaded by forging a forwarding header.
    await securityLimit(db, `recovery:ip:${req.ip}`, 30, 3_600_000);
    await securityLimit(db, `recovery:email:${email}`, 4, 3_600_000);
    if (!accountMailReady(config)) throw new ApiError(503, '账号邮件服务尚未配置，请联系管理员');
    const [op] = await db.orm.select().from(operators).where(eq(operators.email, email));
    if (op?.status === 'active' && (body.purpose === 'reset' || !op.emailVerifiedAt)) await queueAccountMail(db, config, op, body.purpose);
    return { ok: true, message: '如该邮箱符合条件，您将收到邮件，请检查收件箱和垃圾邮件。' };
  });

  app.post('/api/auth/recovery/complete', async req => {
    const body = parse(z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), purpose: z.enum(['reset', 'verify']),
      password: z.string().min(8).max(1024).optional(), code: z.string().max(64).default(''),
    }), req.body);
    await securityLimit(db, `recovery:token:${hashToken(body.token)}`, 8);
    const [found] = await db.orm.select().from(authTokens).where(and(eq(authTokens.tokenHash, hashToken(body.token)),
      eq(authTokens.purpose, body.purpose), gt(authTokens.expiresAt, toPgTimestamp(new Date()))));
    if (!found) throw new ApiError(400, '链接无效、已使用或已过期');
    return withBillingTransaction(db, found.operatorId, async tx => {
      const op = await getOperator(tx, found.operatorId);
      const [used] = await tx.orm.delete(authTokens).where(and(eq(authTokens.tokenHash, found.tokenHash),
        gt(authTokens.expiresAt, toPgTimestamp(new Date())))).returning();
      if (!used) throw new ApiError(400, '链接无效、已使用或已过期');
      if (body.purpose === 'reset') {
        if (!body.password) throw new ApiError(400, '请输入新密码');
        await consumeMfa(tx, config, op, body.code ?? '');
        await tx.orm.update(operators).set({ passwordHash: await hashPassword(body.password) }).where(eq(operators.id, op.id));
        await tx.orm.delete(sessions).where(eq(sessions.operatorId, op.id));
        await tx.orm.delete(authTokens).where(eq(authTokens.operatorId, op.id));
        await queueNotification(tx, config, { operatorId: op.id, category: 'security', key: `password-reset:${found.tokenHash}`,
          subject: '登录密码已重置', body: '您的密码已重置，所有登录会话已退出。若非本人操作，请立即联系管理员。' });
      } else {
        await tx.orm.update(operators).set({ emailVerifiedAt: toPgTimestamp(new Date()) }).where(eq(operators.id, op.id));
      }
      await writeAudit(tx, { actor: op.email, action: `auth.${body.purpose}`, ok: true });
      return { ok: true };
    });
  });

  app.get('/api/auth/security', async req => {
    const op = await getOperator(db, owner(req));
    return { emailVerified: !!op.emailVerifiedAt, mfaEnabled: !!op.mfaSecret,
      mfaRequired: config.adminMfaRequired && op.role === 'root', recoveryCodesRemaining: op.mfaRecoveryHashes.length,
      emailServiceReady: accountMailReady(config), mfaAvailable: !!config.secretKey };
  });

  app.post('/api/auth/mfa/setup', req => reauth(req, 'auth.mfa.setup', async (tx, op, code) => {
    if (!config.secretKey) throw new ApiError(503, '请先配置加密主密钥');
    if (op.mfaSecret) throw new ApiError(409, '已启用二次验证');
    const secret = newTotpSecret();
    await tx.orm.update(operators).set({ mfaPendingSecret: encryptSecret(secret, config.secretKey),
      mfaPendingExpiresAt: toPgTimestamp(new Date(Date.now() + 600_000)),
    }).where(eq(operators.id, op.id));
    return { secret, uri: `otpauth://totp/${encodeURIComponent(`3API:${op.email}`)}?secret=${secret}&issuer=3API&algorithm=SHA1&digits=6&period=30` };
  }));
  app.post('/api/auth/mfa/enable', req => reauth(req, 'auth.mfa.enable', async (tx, op, code) => {
    if (op.mfaSecret || !op.mfaPendingSecret || !op.mfaPendingExpiresAt || op.mfaPendingExpiresAt <= toPgTimestamp(new Date()) || !config.secretKey) {
      throw new ApiError(400, '设置已过期，请重新开始');
    }
    const counter = totpCounter(decryptSecret(op.mfaPendingSecret, config.secretKey), code, -1);
    if (counter === null) throw new ApiError(400, '验证码错误');
    const codes = Array.from({ length: 10 }, () => randomBytes(8).toString('hex'));
    await tx.orm.update(operators).set({ mfaSecret: op.mfaPendingSecret, mfaPendingSecret: null, mfaPendingExpiresAt: null,
      mfaLastCounter: counter, mfaRecoveryHashes: codes.map(hashToken),
    }).where(eq(operators.id, op.id));
    await tx.orm.delete(sessions).where(eq(sessions.operatorId, op.id));
    await tx.orm.delete(authTokens).where(eq(authTokens.operatorId, op.id));
    return { ok: true, recoveryCodes: codes, loginRequired: true };
  }));
  app.post('/api/auth/mfa/disable', req => reauth(req, 'auth.mfa.disable', async (tx, op, code) => {
    if (config.adminMfaRequired && op.role === 'root') throw new ApiError(403, '平台要求管理员保持二次验证');
    if (!op.mfaSecret) throw new ApiError(400, '尚未启用二次验证');
    await consumeMfa(tx, config, op, code);
    await tx.orm.update(operators).set({ mfaSecret: null, mfaRecoveryHashes: [], mfaLastCounter: -1,
      mfaPendingSecret: null, mfaPendingExpiresAt: null }).where(eq(operators.id, op.id));
    await tx.orm.delete(sessions).where(eq(sessions.operatorId, op.id));
    await tx.orm.delete(authTokens).where(eq(authTokens.operatorId, op.id));
    return { ok: true, loginRequired: true };
  }));

  app.post('/api/auth/mfa/login', async (req, reply) => {
    const body = parse(z.object({ challenge: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().min(1).max(64) }), req.body);
    const [found] = await db.orm.select().from(authTokens).where(and(eq(authTokens.tokenHash, hashToken(body.challenge)),
      eq(authTokens.purpose, 'mfa'), gt(authTokens.expiresAt, toPgTimestamp(new Date()))));
    if (!found) throw new ApiError(400, '登录验证已过期，请重新登录');
    await securityLimit(db, `mfa:${found.operatorId}`, 10);
    const result = await withBillingTransaction(db, found.operatorId, async tx => {
      const op = await getOperator(tx, found.operatorId);
      const [consumed] = await tx.orm.delete(authTokens).where(and(eq(authTokens.tokenHash, found.tokenHash),
        gt(authTokens.expiresAt, toPgTimestamp(new Date())))).returning();
      if (!consumed || !op.mfaSecret) throw new ApiError(400, '登录验证已过期，请重新登录');
      await consumeMfa(tx, config, op, body.code ?? '');
      const { token } = await createSession(tx, op.id, config.sessionTtlHours, { ip: req.ip });
      await tx.orm.update(operators).set({ lastLoginAt: toPgTimestamp(new Date()) }).where(eq(operators.id, op.id));
      await writeAudit(tx, { actor: op.email, action: 'auth.mfa.login', ok: true });
      return { token, me: { email: op.email, displayName: op.displayName, role: op.role, signupMode: config.signupMode } };
    });
    reply.setCookie(SESSION_COOKIE, result.token, sessionCookieOptions(config.sessionTtlHours, config.publicUrl?.startsWith('https:')));
    return result.me;
  });

  app.get('/api/auth/sessions', async req => {
    const list = await db.orm.select({ tokenHash: sessions.tokenHash, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt,
      ip: sessions.ip, userAgent: sessions.userAgent }).from(sessions).where(and(eq(sessions.operatorId, owner(req)),
        gt(sessions.expiresAt, toPgTimestamp(new Date()))));
    const current = hashToken(req.cookies[SESSION_COOKIE] ?? '');
    return { sessions: list.map(({ tokenHash, ...row }) => ({ ...row, id: tokenHash, current: tokenHash === current })) };
  });
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async req => {
    await db.orm.delete(sessions).where(and(eq(sessions.operatorId, owner(req)), eq(sessions.tokenHash, req.params.id)));
    return { ok: true };
  });
}
