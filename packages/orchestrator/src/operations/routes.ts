import { and, desc, eq, isNull, like, lt, gt, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { appSettings, auditEvents, notifications, operators, paymentOrders, sites, schemaMigrations } from '../db/schema.js';
import { ApiError, requireRoot, requireWrite, tenantId } from '../auth/rbac.js';
import { inspectLocalEnvironment } from '../provision/environment.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { accountMailReady } from '../auth/security.js';
import { BACKUP_STATE, performPanelBackup } from './backup.js';
import { writeAudit } from '../audit.js';
import { csvCell } from '../billing/aftercare.js';

export function registerOperationsRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
  app.get('/api/local/environment', async req => {
    requireWrite(req.ctx!);
    if (!config.localProvisionEnabled || config.deploymentMode !== 'self-hosted') return { enabled: false, ready: false, checks: [] };
    const result = await inspectLocalEnvironment(config.sitesRoot, config.dockerViaWsl);
    result.checks.push({ key: 'encryption', ok: !!config.secretKey, detail: 'Configure RP_SECRET_KEY to encrypt engine administrator credentials' });
    return { ...result, enabled: true, ready: result.checks.every(c => c.ok), portRange: config.portRange,
      ...(req.ctx!.role === 'root' ? { sitesRoot: config.sitesRoot } : {}) };
  });
  app.get('/api/onboarding', async req => {
    const ctx = req.ctx!;
    const [account] = await db.orm.select().from(operators).where(eq(operators.id, ctx.operatorId));
    const owned = await db.orm.select({ id: sites.id, label: sites.label, readonly: sites.readonly }).from(sites)
      .where(and(eq(sites.operatorId, tenantId(ctx)), ne(sites.status, 'destroyed')));
    return { mode: config.deploymentMode, emailVerified: !!account?.emailVerifiedAt, mfaEnabled: !!account?.mfaSecret,
      connectedSites: owned.length, readonlySites: owned.filter(s => s.readonly).length, hardwareProvided: false };
  });
  app.get('/api/admin/operations', async req => {
    requireRoot(req.ctx!);
    const [backup] = await db.orm.select().from(appSettings).where(eq(appSettings.key, BACKUP_STATE));
    const [pending] = await db.orm.select({ count: sql<number>`count(*)::int` }).from(paymentOrders)
      .where(and(eq(paymentOrders.status, 'paid'), lt(paymentOrders.paidAt, toPgTimestamp(new Date(Date.now() - 300_000)))));
    const [failedMail] = await db.orm.select({ count: sql<number>`count(*)::int` }).from(notifications).where(eq(notifications.status, 'failed'));
    const [missingMfa] = await db.orm.select({ count: sql<number>`count(*)::int` }).from(operators)
      .where(and(eq(operators.role, 'root'), eq(operators.status, 'active'), isNull(operators.mfaSecret)));
    const lastCompleted = Date.parse(String(backup?.value.completedAt ?? ''));
    return { deploymentMode: config.deploymentMode, provisioningDisabled: !config.localProvisionEnabled,
      accountEmailReady: accountMailReady(config), emailVerificationRequired: config.emailVerificationRequired,
      adminMfaRequired: config.adminMfaRequired, adminsWithoutMfa: missingMfa?.count ?? 0,
      backup: backup?.value ?? null, automaticBackupEnabled: config.backupIntervalMs > 0,
      backupExcludedTables: config.backupExcludeTables,
      backupOverdue: !Number.isFinite(lastCompleted) || Date.now() - lastCompleted > Math.max(86_400_000, config.backupIntervalMs * 1.5),
      paidUnfulfilled: pending?.count ?? 0, failedNotifications: failedMail?.count ?? 0,
      migrations: (await db.orm.select({ name: schemaMigrations.name }).from(schemaMigrations)).map(x => x.name),
    };
  });
  app.post('/api/admin/operations/backup', async req => { requireRoot(req.ctx!); return performPanelBackup(db, config, req.ctx!.email); });
  app.get<{ Querystring: { afterId?: string } }>('/api/audit/export.csv', async (req, reply) => {
    const ctx = req.ctx!;
    if (ctx.role === 'viewer') throw new ApiError(403, '平台观察员不能导出审计');
    const afterId = req.query.afterId === undefined ? 0 : Number(req.query.afterId);
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ApiError(400, '审计游标无效');
    const rows = await db.orm.select({ id: auditEvents.id, at: auditEvents.createdAt, actor: auditEvents.actor, action: auditEvents.action,
      site: sites.label, ok: auditEvents.ok }).from(auditEvents).leftJoin(sites, eq(sites.id, auditEvents.siteId))
      .where(and(gt(auditEvents.id, afterId), ctx.role === 'root' ? undefined : or(eq(sites.operatorId, tenantId(ctx)),
        and(eq(auditEvents.actor, ctx.email), isNull(auditEvents.siteId), or(like(auditEvents.action, 'auth.%'), like(auditEvents.action, 'support.%'), like(auditEvents.action, 'team.%'))))))
      .orderBy(auditEvents.id).limit(10_000);
    reply.header('X-Next-After-Id', String(rows.at(-1)?.id ?? afterId));
    await writeAudit(db, { actor: ctx.email, action: 'audit.export', payload: { rows: rows.length, ownerId: tenantId(ctx) }, ok: true });
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="audit.csv"')
      .send('\ufeff' + [['ID', 'UTC time', 'Actor', 'Action', 'Site', 'Success'], ...rows.map(r => [r.id, r.at, r.actor, r.action, r.site, r.ok])]
        .map(r => r.map(csvCell).join(',')).join('\r\n'));
  });
}
