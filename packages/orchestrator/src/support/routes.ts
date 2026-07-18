import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';

/**
 * 托管版支持面：面板内「帮助与支持」的数据源。
 *  - GET /api/support           全员：支持邮箱/工单链接/文档链接（未配置字段为 null）
 *  - PUT /api/settings/support  root：写 app_settings['support_contact']
 */

const SUPPORT_SETTINGS_KEY = 'support_contact';

const supportBody = z.object({
  email: z.string().email().nullable().optional(),
  url: z.string().url().nullable().optional(),
  docsUrl: z.string().url().nullable().optional(),
});

interface SupportValue {
  email?: string;
  url?: string;
  docsUrl?: string;
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

export function registerSupportRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  async function readValue(): Promise<SupportValue> {
    const rows = await db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, SUPPORT_SETTINGS_KEY))
      .limit(1);
    return (rows[0]?.value as SupportValue | undefined) ?? {};
  }

  app.get('/api/support', async (req) => {
    requireCtx(req);
    const v = await readValue();
    return {
      email: v.email ?? null,
      url: v.url ?? null,
      docsUrl: v.docsUrl ?? null,
    };
  });

  app.put('/api/settings/support', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = supportBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      throw new ApiError(400, `请求参数无效: ${issues}`);
    }
    const prev = await readValue();
    const next: SupportValue = { ...prev };
    for (const k of ['email', 'url', 'docsUrl'] as const) {
      const v = parsed.data[k];
      if (v === undefined) continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const now = toPgTimestamp(new Date());
    await db.orm
      .insert(appSettings)
      .values({ key: SUPPORT_SETTINGS_KEY, value: next as Record<string, unknown>, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: next as Record<string, unknown>, updatedAt: now } });
    await writeAudit(db, {
      actor: ctx.email,
      action: 'settings.support',
      payload: { hasEmail: next.email !== undefined, hasUrl: next.url !== undefined, hasDocs: next.docsUrl !== undefined },
      ok: true,
    });
    return { ok: true, email: next.email ?? null, url: next.url ?? null, docsUrl: next.docsUrl ?? null };
  });
}
