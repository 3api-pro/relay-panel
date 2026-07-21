import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appSettings } from '../db/schema.js';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { RECHARGE_LINKS_KEY, buildBalanceOverview, isHttpUrl, readRechargeLinks } from './service.js';

/**
 * 上游渠道"余额/可用度" + 快捷充值路由（F5，口径风险最高，全部 requireRoot——含上游账户结构/成本，nav 亦 rootOnly）：
 *  - GET /api/upstream/balances?days=N   跨站上游余额/可用度（days 1..90 默认7；诚实标注覆盖盲区）
 *  - GET /api/upstream/recharge-links     读充值外链
 *  - PUT /api/upstream/recharge-links     盲覆盖写充值外链（zod 校验 + url 必 http/https + 审计）
 *
 * 🔴 只读呈现 + 外链 + 手工记账：绝不实现 reset-quota / 砍余额 / 任何引擎写端点。
 *    绝不调用 sub2api 已存在的 POST /accounts/:id/reset-quota，adapter 也无该方法。
 * 金额单位 USD（本行业 USD:RMB 1:1，无汇率）。deps 是 SitesServiceDeps。
 */

function requireCtx(req: FastifyRequest): SessionCtx {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

/** 充值外链条目：label 必填、url 必填(且 http/https，见 handler 复核)、note 可选。条数/长度上限护栏。 */
const rechargeLinkSchema = z.object({
  label: z.string().min(1).max(120),
  url: z.string().min(1).max(2000),
  note: z.string().max(500).optional(),
});
const rechargeLinksBody = z.object({
  links: z.array(rechargeLinkSchema).max(50),
});

export function registerUpstreamRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const service = new SitesService(deps);

  // ---- 上游余额/可用度（仅 root）----
  app.get<{ Querystring: { days?: string } }>('/api/upstream/balances', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const daysRaw = req.query.days;
    const days = daysRaw === undefined ? 7 : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new ApiError(400, '参数 days 须为 1-90 的整数');
    }
    const rows = await service.listSiteChannelBalances(ctx, days);
    const overview = buildBalanceOverview(rows, deps.config.channelBalanceThreshold);
    return {
      days,
      thresholdUsd: deps.config.channelBalanceThreshold,
      costUnit: 'USD',
      coverage: overview.coverage,
      rows: overview.rows,
    };
  });

  // ---- 充值外链读（仅 root）----
  app.get('/api/upstream/recharge-links', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return { links: await readRechargeLinks(deps) };
  });

  // ---- 充值外链写（仅 root；盲覆盖 upsert app_settings['channel_recharge_links']）----
  app.put('/api/upstream/recharge-links', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = rechargeLinksBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
    // 🔴 url 必 http/https（zod 已校验非空/长度，此处复核协议，拒 javascript:/file: 等）
    for (const l of parsed.data.links) {
      if (!isHttpUrl(l.url)) throw new ApiError(400, '充值链接 URL 必须为 http 或 https');
    }
    const links = parsed.data.links.map((l) => ({
      label: l.label,
      url: l.url,
      ...(l.note ? { note: l.note } : {}),
    }));
    // app_settings.value 是对象口径：包 { links } 存（与 alert_webhook_url/finance_cost_ratios 同为对象 upsert）
    const value: Record<string, unknown> = { links };
    const now = toPgTimestamp(new Date());
    await deps.db.orm
      .insert(appSettings)
      .values({ key: RECHARGE_LINKS_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });

    // 审计只记条数，不记外链明文（外链非机密但保持最小化）
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'upstream.recharge_links.set',
      payload: { count: links.length },
      ok: true,
    });

    return { links };
  });
}
