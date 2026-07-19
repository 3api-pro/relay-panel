import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { alerts, appSettings, sites, type AlertRow } from '../db/schema.js';
import { ApiError, canAccessSite, requireRoot, requireWrite, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { resolveAlert } from './engine.js';
import { ALERT_EMAIL_SETTINGS_KEY, WEBHOOK_SETTINGS_KEY, type Notifier } from './notify.js';

/**
 * 告警路由（规格 §8）：
 *  - GET  /api/alerts?status=open|resolved|all（默认 open；operator 只见 own 站，
 *    site_id null 的全局告警仅 root/viewer 可见）
 *  - POST /api/alerts/:id/resolve（requireWrite + 站点归属校验；resolve 触发通知事件）
 *  - GET/PUT /api/settings/alerts（root；webhook 地址存 app_settings['alert_webhook_url']，
 *    告警邮箱存 app_settings['alert_email_to']；两者独立、可分别设置/清除）
 * deps 是 buildServer 完整 deps 的结构化子集，直接传全量对象即可。
 */

export interface AlertsRoutesDeps {
  config: Config;
  db: Db;
  notifier: Notifier;
}

const statusQuery = z.enum(['open', 'resolved', 'all']);

/**
 * 告警通知设置：webhookUrl / alertEmailTo 均可选（未传则不改动该项），
 * '' 与 null 表示清除该项。webhook 限 http/https；邮箱须合法。
 */
const settingsBody = z.object({
  webhookUrl: z
    .union([
      z
        .string()
        .url('无效的 webhook 地址')
        .max(500, 'webhook 地址过长')
        .refine((u) => u.startsWith('http://') || u.startsWith('https://'), '仅支持 http/https 地址'),
      z.literal(''),
      z.null(),
    ])
    .optional(),
  alertEmailTo: z
    .union([z.string().email('无效的邮箱地址').max(320, '邮箱地址过长'), z.literal(''), z.null()])
    .optional(),
});

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function requireCtx(req: FastifyRequest): SessionCtx {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

/**
 * 可见性：root/viewer 全量（含 site_id null 的全局告警）；
 * operator 仅 own 站的告警——全局告警与站点行已缺失的告警一律不可见。
 */
function canSeeAlert(
  ctx: SessionCtx,
  alert: Pick<AlertRow, 'siteId'>,
  siteOperatorId: number | null,
): boolean {
  if (ctx.role === 'root' || ctx.role === 'viewer') return true;
  if (alert.siteId === null || siteOperatorId === null) return false;
  return canAccessSite(ctx, { operatorId: siteOperatorId });
}

export function registerAlertsRoutes(app: FastifyInstance, deps: AlertsRoutesDeps): void {
  const { db } = deps;

  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/alerts', async (req) => {
    const ctx = requireCtx(req);

    const parsed = statusQuery.safeParse(req.query.status ?? 'open');
    if (!parsed.success) throw new ApiError(400, '无效的 status 参数（open|resolved|all）');
    const status = parsed.data;

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    // 可见性下推 SQL（修复 F）：先按 operator 过滤再 LIMIT，避免 own 站告警被他人告警
    // 挤出 lastSeenAt 窗口。sites 为 leftJoin——operator 加 sites.operator_id = 自身：
    // site_id 为 null 的全局告警 leftJoin 后 operatorId 为 NULL，不匹配，天然排除
    // （全局告警仅 root/viewer 可见）。root/viewer 不加可见性过滤。
    const conds: SQL[] = [];
    if (status !== 'all') conds.push(eq(alerts.status, status));
    if (ctx.role === 'operator') conds.push(eq(sites.operatorId, ctx.operatorId));

    const rows = await db.orm
      .select({
        alert: alerts,
        siteSlug: sites.slug,
        siteLabel: sites.label,
        siteOperatorId: sites.operatorId,
      })
      .from(alerts)
      .leftJoin(sites, eq(alerts.siteId, sites.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(alerts.lastSeenAt), desc(alerts.id))
      .limit(limit);

    // 兜底二次校验：SQL 已按可见性过滤，此处防御性再确认一遍（含 root/viewer 全量放行）
    const visible = rows.filter((r) => canSeeAlert(ctx, r.alert, r.siteOperatorId));
    return {
      alerts: visible.map((r) => ({
        ...r.alert,
        siteSlug: r.siteSlug,
        siteLabel: r.siteLabel,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/resolve', async (req) => {
    const ctx = requireCtx(req);
    requireWrite(ctx);

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, '无效的告警 id');

    const rows = await db.orm
      .select({ alert: alerts, site: sites })
      .from(alerts)
      .leftJoin(sites, eq(alerts.siteId, sites.id))
      .where(eq(alerts.id, id))
      .limit(1);
    const row = rows[0];
    // 无权可见的告警按不存在处理（不向 operator 泄露他站/全局告警的存在性）
    if (!row || !canSeeAlert(ctx, row.alert, row.site?.operatorId ?? null)) {
      throw new ApiError(404, '告警不存在');
    }
    if (row.alert.status !== 'open') throw new ApiError(400, '告警已是已解决状态');

    const siteRef = row.site ? { slug: row.site.slug, label: row.site.label } : undefined;
    const updated = await resolveAlert(db, deps.notifier, row.alert, siteRef);
    await writeAudit(db, {
      siteId: row.alert.siteId,
      actor: ctx.email,
      action: 'alert.resolve',
      payload: { alertId: id, kind: row.alert.kind },
      ok: true,
    });
    return { ok: true, alert: updated ?? row.alert };
  });

  /** 读某设置行的单字段字符串值（缺失/空串归一为 null） */
  async function readStringSetting(key: string, field: string): Promise<string | null> {
    const rows = await db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    const v = (rows[0]?.value as Record<string, unknown> | undefined)?.[field];
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** upsert 单字段设置行 */
  async function writeStringSetting(key: string, field: string, value: string, now: string): Promise<void> {
    await db.orm
      .insert(appSettings)
      .values({ key, value: { [field]: value }, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { [field]: value }, updatedAt: now } });
  }

  app.get('/api/settings/alerts', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return {
      webhookUrl: await readStringSetting(WEBHOOK_SETTINGS_KEY, 'url'),
      alertEmailTo: await readStringSetting(ALERT_EMAIL_SETTINGS_KEY, 'email'),
    };
  });

  app.put('/api/settings/alerts', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);

    const parsed = settingsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      throw new ApiError(400, `请求参数无效: ${issues}`);
    }
    const { webhookUrl, alertEmailTo } = parsed.data;

    const now = toPgTimestamp(new Date());
    // 只更新请求里显式给出的项（undefined=不动；'' 或 null=清除）
    if (webhookUrl !== undefined) {
      await writeStringSetting(WEBHOOK_SETTINGS_KEY, 'url', webhookUrl ?? '', now);
    }
    if (alertEmailTo !== undefined) {
      await writeStringSetting(ALERT_EMAIL_SETTINGS_KEY, 'email', alertEmailTo ?? '', now);
    }

    const nextWebhook = await readStringSetting(WEBHOOK_SETTINGS_KEY, 'url');
    const nextEmail = await readStringSetting(ALERT_EMAIL_SETTINGS_KEY, 'email');
    // webhook 地址可能内嵌调用凭据、邮箱属 PII——审计只记"是否配置"不记原值
    await writeAudit(db, {
      actor: ctx.email,
      action: 'settings.alerts',
      payload: { hasWebhook: nextWebhook !== null, hasEmail: nextEmail !== null },
      ok: true,
    });
    return { ok: true, webhookUrl: nextWebhook, alertEmailTo: nextEmail };
  });
}
