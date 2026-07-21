import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { EngineAdapter, EngineKind } from '@relay-panel/adapter-core';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { writeAudit } from '../audit.js';
import type { Notifier } from '../alerts/notify.js';
import { RiskService, type QuotaChange } from './service.js';

/**
 * 风控路由（F3）。全部 requireRoot（风控涉及跨站客户消费与上游成本维度，仅 root 可见）：
 *  - GET  /api/risk/rules                    读规则 + {enforce:config.riskEnforce}
 *  - PUT  /api/risk/rules                    写规则（app_settings['risk_rules']，合并式）
 *  - POST /api/risk/scan                     跑侦测，返回 spikes[]（绝不写回引擎限额）
 *  - POST /api/risk/users/:slug/:userId/quota-preview   GET-合并预览（不写）
 *  - POST /api/risk/users/:slug/:userId/enforce         仅 config.riskEnforce 时执行 GET-合并-PUT，否则 403
 * 金额响应显式标 USD。deps 是 buildServer 完整 deps 的结构化子集。
 */

export interface RiskRoutesDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  notifier: Notifier;
}

function requireCtx(req: FastifyRequest): SessionCtx {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

const rulesBody = z.object({
  spikeMultiplier: z.number().min(1).max(1000).optional(),
  absFloorUsd: z.number().min(0).max(1_000_000_000).optional(),
  baselineDays: z.number().int().min(1).max(90).optional(),
});

/** platform ∈ AllowedQuotaPlatforms；limitUsd null=不限/0=禁用/>0=上限（USD） */
const quotaChangeBody = z.object({
  platform: z.enum(['anthropic', 'openai', 'gemini', 'codex', 'grok']),
  window: z.enum(['daily', 'weekly', 'monthly']),
  limitUsd: z.number().min(0).max(1_000_000_000).nullable(),
});

export function registerRiskRoutes(app: FastifyInstance, deps: RiskRoutesDeps): void {
  const service = new RiskService(deps);

  // ---- 规则读写 ----
  app.get('/api/risk/rules', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const rules = await service.readRules();
    return { rules, enforce: deps.config.riskEnforce };
  });

  app.put('/api/risk/rules', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = rulesBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
    const rules = await service.writeRules(parsed.data);
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'risk.rules.set',
      payload: { ...rules },
      ok: true,
    });
    return { rules, enforce: deps.config.riskEnforce };
  });

  // ---- 侦测（绝不写回引擎限额）----
  app.post('/api/risk/scan', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const grouped = await service.scan({ openAlerts: true });
    const spikes = grouped.flatMap((g) =>
      g.spikes.map((s) => ({
        siteSlug: g.siteSlug,
        siteLabel: g.siteLabel,
        userId: s.userId,
        email: s.email,
        recentCost: s.recentCost,
        baselineDaily: s.baselineDaily,
        // Infinity（无基线/新增）→ null，供前端显示「新增」
        ratio: Number.isFinite(s.ratio) ? s.ratio : null,
      })),
    );
    return { spikes, enforce: deps.config.riskEnforce, costUnit: 'USD' };
  });

  // ---- GET-合并预览（不写）----
  app.post<{ Params: { slug: string; userId: string } }>(
    '/api/risk/users/:slug/:userId/quota-preview',
    async (req) => {
      const ctx = requireCtx(req);
      requireRoot(ctx);
      const parsed = quotaChangeBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
      const preview = await service.previewQuota(req.params.slug, req.params.userId, parsed.data as QuotaChange);
      return { ...preview, enforce: deps.config.riskEnforce, costUnit: 'USD' };
    },
  );

  // ---- 写回（仅 config.riskEnforce=on；off 直接 403）----
  app.post<{ Params: { slug: string; userId: string } }>(
    '/api/risk/users/:slug/:userId/enforce',
    async (req) => {
      const ctx = requireCtx(req);
      requireRoot(ctx);
      // 🔴 双门控：UI 与后端同读 config.riskEnforce；off 时直接拒绝，绝不触发 setPlatformQuotas
      if (!deps.config.riskEnforce) {
        throw new ApiError(403, '仅告警模式：限额写回需 RP_RISK_ENFORCE=on');
      }
      const parsed = quotaChangeBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
      const result = await service.enforceQuota(ctx, req.params.slug, req.params.userId, parsed.data as QuotaChange);
      return { ...result, enforce: true, costUnit: 'USD' };
    },
  );
}
