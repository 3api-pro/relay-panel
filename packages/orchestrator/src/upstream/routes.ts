import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appSettings } from '../db/schema.js';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { RECHARGE_LINKS_KEY, buildBalanceOverview, isHttpUrl, readRechargeLinks } from './service.js';
import { readTrustedUpstreamManifests } from './manifest.js';
import { listVendorBalances } from './vendors.js';

/**
 * 上游渠道"余额/可用度" + 快捷充值路由（F5，口径风险最高，全部 requireRoot——含上游账户结构/成本，nav 亦 rootOnly）：
 *  - GET  /api/upstream/balances?days=N            跨站上游余额/可用度（days 1..90 默认7；诚实标注覆盖盲区）
 *  - GET  /api/upstream/recharge-links             读充值外链
 *  - PUT  /api/upstream/recharge-links             盲覆盖写充值外链（zod 校验 + url 必 http/https + 审计）
 *  - POST /api/upstream/channels/:slug/:channelId/reset-quota
 *        🔴 不可逆写：清零该 quota 型渠道已用额度计数（快捷充值/续杯）。多重硬闸：
 *        requireRoot + 站点 readonly 403 + env RP_UPSTREAM_RESET_ENABLED 门控(默认 off 403)
 *        + 确认令牌 confirm 精确等于渠道名 + 仅 kind='quota'(window/none 400) + 逐条不批量 + 全量审计(before/after)。
 *
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

/**
 * reset-quota 请求体：confirm=确认令牌（须精确等于目标渠道名，防误点/跨渠道错 id，服务端以引擎实时读的渠道名复核）；
 * days=返回行的窗口（算 daysLeft 用，1..90 默认7，与 balances 页当前窗口对齐）。
 */
const resetQuotaBody = z.object({
  confirm: z.string().min(1).max(200),
  days: z.number().int().min(1).max(90).optional(),
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
      // 前端据此决定是否展示"重置已用"动作（关时按钮 disabled + 提示，避免必然 403 的误点）
      resetEnabled: deps.config.upstreamResetEnabled,
      coverage: overview.coverage,
      rows: overview.rows,
    };
  });

  // ---- 上游【供应商】钱包余额（仅 root）----
  // 与上面 /balances 的区别：那个是「我方站点 × 渠道」的额度口径（同一家上游会在 4 个站各出现一次），
  // 这个是「采购视角」——每家上游那里还剩多少钱、按当前烧钱速度还能撑几天，按供应商折叠成一行。
  // 数据直连上游自己的账单接口（见 vendors.ts），5min 缓存；?force=1 跳过缓存。
  app.get<{ Querystring: { force?: string } }>('/api/upstream/vendors', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return listVendorBalances(
      {
        db: deps.db,
        ...(deps.config.secretKey !== undefined ? { secretKey: deps.config.secretKey } : {}),
        discover: async ({ force }) => {
          const [sitesResult, manifestsResult] = await Promise.allSettled([
            service.listUpstreamWalletCandidates(ctx, force ? { force: true } : {}),
            // V3 已用 5min 脱敏快照缓存保护上游。Relay 的“强制刷新”只强刷受管引擎；
            // 不再同时让两个 V3 实例绕过缓存，避免同一批生图 key 被双倍探测并超过清单读取时限。
            readTrustedUpstreamManifests(deps.config.upstreamManifestUrls),
          ]);
          return [
            ...(sitesResult.status === 'fulfilled' ? sitesResult.value : []),
            ...(manifestsResult.status === 'fulfilled' ? manifestsResult.value : []),
          ];
        },
      },
      { force: req.query.force === '1' },
    );
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

  // ---- 快捷充值/额度重置（仅 root；不可逆写，多重硬闸；env 默认 off）----
  app.post<{ Params: { slug: string; channelId: string } }>(
    '/api/upstream/channels/:slug/:channelId/reset-quota',
    async (req) => {
      const ctx = requireCtx(req);
      requireRoot(ctx);
      // 🔴 env 门控：默认 off 时直接拒绝，绝不触发任何引擎写（与 F3 riskEnforce 同范式）
      if (!deps.config.upstreamResetEnabled) {
        throw new ApiError(403, '快捷充值写操作未启用，需 RP_UPSTREAM_RESET_ENABLED=1');
      }
      const parsed = resetQuotaBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
      const days = parsed.data.days ?? 7;
      // 逐条：单渠道一次；确认令牌=渠道名、readonly、kind 判定、审计（before/after）均在 service 内
      const result = await service.resetChannelQuota(
        ctx,
        req.params.slug,
        req.params.channelId,
        parsed.data.confirm,
        days,
      );
      // 装配对客视图行（复用 buildBalanceOverview 的口径守卫：window/none 不给余额数）；重读失败则 row=null
      const overview = result.row
        ? buildBalanceOverview([result.row], deps.config.channelBalanceThreshold)
        : null;
      return {
        ok: true,
        channelId: req.params.channelId,
        channelName: result.channelName,
        quotaUsedBefore: result.quotaUsedBefore,
        quotaUsedAfter: result.quotaUsedAfter,
        costUnit: 'USD',
        row: overview?.rows[0] ?? null,
      };
    },
  );
}
