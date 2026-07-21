import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EngineAdapter, EngineKind } from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ApiError, requireRoot, type SessionCtx } from '../auth/rbac.js';
import { writeAudit } from '../audit.js';
import type { Notifier } from '../alerts/notify.js';
import {
  addDaysStr,
  beijingTodayStr,
  churnAssess,
  collectLiveCustomers,
  detectDrop,
  loadSnapshotHistory,
  readCrmConfig,
  tierOf,
  writeCrmConfig,
  type ChurnReason,
  type CrmConfig,
  type CustomerTier,
  type DegradedSite,
} from './service.js';
import { runCustomerSnapshotOnce } from './snapshot.js';

/**
 * 客户 CRM 路由（F4）。全部 requireRoot（含客户邮箱/负债敏感，仅 root 可见；nav 亦 rootOnly）：
 *  - GET  /api/customers          客户资产/活跃/流失一屏（实时采集 + 快照历史算骤降/流失）
 *  - GET  /api/customers/config   读分层门槛/流失阈值配置
 *  - PUT  /api/customers/config   写配置（app_settings['customer_crm_config'] 独立 key 盲覆盖，zod 校验 + 审计）
 *  - POST /api/customers/snapshot 手动补一轮快照（冷启动 seeding，只写本表非破坏）
 * 🔴 纯只读分析：绝不写回引擎、不改额度/砍余额；余额=客户预付负债(user.balance)，与上游 channel 严格区分。
 * 金额口径 USD（本行业 USD:RMB 1:1）。deps 是 buildServer 完整 deps 的结构化子集。
 */

export interface CustomersRoutesDeps {
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

/** 单客户 CRM 行（与 web/api/types.ts 的 CustomerCrmRow 同构） */
export interface CustomerCrmRow {
  /** 跨站不合并唯一键 siteSlug:userId（前端 table row-key） */
  key: string;
  siteSlug: string;
  siteLabel: string;
  userId: number;
  email: string | null;
  /** 客户预付余额（对客负债，USD） */
  balance: number;
  frozenBalance: number;
  totalRecharged: number;
  status: 'active' | 'disabled';
  lastActiveAt: string | null;
  lastUsedAt: string | null;
  tier: CustomerTier;
  /** 近窗口日均消费（估算，USD） */
  windowSpend: number;
  dailySpendRecent: number;
  dailySpendPrior: number;
  /** 消费降幅比例 0..1 */
  dropPct: number;
  churnRisk: boolean;
  churnReasons: ChurnReason[];
  hasSubscription: boolean;
  /** 骤降信号历史是否充足（冷启动 false，UI 标注） */
  enoughHistory: boolean;
}

export interface CustomerTotals {
  customers: number;
  /** 负债合计=Σbalance（🔴 跨站同一人重复计，UI 注明；USD） */
  liabilityTotal: number;
  tierBig: number;
  tierMid: number;
  tierSmall: number;
  churnCount: number;
  subscriptionCount: number;
}

export interface CustomersResponse {
  generatedAt: string;
  config: CrmConfig;
  /** 已积累的快照天数（distinct captured_date）；< minSnapshotDays 时 UI 提示需继续积累 */
  snapshotDaysAvailable: number;
  rows: CustomerCrmRow[];
  totals: CustomerTotals;
  degradedSites: DegradedSite[];
  costUnit: 'USD';
}

const configBody = z.object({
  tierBigUsd: z.number().min(0).max(1_000_000_000).optional(),
  tierMidUsd: z.number().min(0).max(1_000_000_000).optional(),
  churnInactiveDays: z.number().int().min(1).max(3650).optional(),
  dropWindowDays: z.number().int().min(1).max(90).optional(),
  dropThresholdPct: z.number().min(0).max(1).optional(),
  minSnapshotDays: z.number().int().min(2).max(90).optional(),
  churnAlertsEnabled: z.boolean().optional(),
});

export function registerCustomersRoutes(app: FastifyInstance, deps: CustomersRoutesDeps): void {
  // ---- 客户资产/活跃/流失总览 ----
  app.get('/api/customers', async (req): Promise<CustomersResponse> => {
    const ctx = requireCtx(req);
    requireRoot(ctx);

    const cfg = await readCrmConfig(deps.db);
    const collected = await collectLiveCustomers(deps);
    const today = beijingTodayStr();

    // 拉够两窗口对比 + 冷启动天数统计的历史
    const slugs = [...new Set(collected.customers.map((c) => c.siteSlug))];
    const since = addDaysStr(today, -(cfg.dropWindowDays * 2 + 5));
    const history = await loadSnapshotHistory(deps.db, slugs, since);

    // 已积累快照天数（distinct captured_date）
    const daySet = new Set<string>();
    for (const arr of history.values()) for (const p of arr) daySet.add(p.capturedDate);
    const snapshotDaysAvailable = daySet.size;

    const rows: CustomerCrmRow[] = collected.customers.map((c) => {
      const drop = detectDrop(history.get(c.key) ?? [], cfg);
      const churn = churnAssess(c, drop, cfg);
      return {
        key: c.key,
        siteSlug: c.siteSlug,
        siteLabel: c.siteLabel,
        userId: c.userId,
        email: c.email ?? null,
        balance: c.balance ?? 0,
        frozenBalance: c.frozenBalance ?? 0,
        totalRecharged: c.totalRecharged ?? 0,
        status: c.status,
        lastActiveAt: c.lastActiveAt ?? null,
        lastUsedAt: c.lastUsedAt ?? null,
        tier: tierOf(c.totalRecharged ?? 0, cfg),
        windowSpend: drop.dailySpendRecent,
        dailySpendRecent: drop.dailySpendRecent,
        dailySpendPrior: drop.dailySpendPrior,
        dropPct: drop.dropPct,
        churnRisk: churn.churnRisk,
        churnReasons: churn.reasons,
        hasSubscription: c.hasSubscription === true,
        enoughHistory: drop.enoughHistory,
      };
    });

    // 流失优先，其次累计充值降序（大 R 靠前）
    rows.sort((a, b) => {
      if (a.churnRisk !== b.churnRisk) return a.churnRisk ? -1 : 1;
      return b.totalRecharged - a.totalRecharged;
    });

    const totals: CustomerTotals = {
      customers: rows.length,
      liabilityTotal: rows.reduce((s, r) => s + r.balance, 0),
      tierBig: rows.filter((r) => r.tier === 'big').length,
      tierMid: rows.filter((r) => r.tier === 'mid').length,
      tierSmall: rows.filter((r) => r.tier === 'small').length,
      churnCount: rows.filter((r) => r.churnRisk).length,
      subscriptionCount: rows.filter((r) => r.hasSubscription).length,
    };

    return {
      generatedAt: new Date().toISOString(),
      config: cfg,
      snapshotDaysAvailable,
      rows,
      totals,
      degradedSites: collected.degradedSites,
      costUnit: 'USD',
    };
  });

  // ---- 配置读写 ----
  app.get('/api/customers/config', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return { config: await readCrmConfig(deps.db) };
  });

  app.put('/api/customers/config', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = configBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
    const config = await writeCrmConfig(deps.db, parsed.data);
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'customers.config.set',
      payload: { ...config },
      ok: true,
    });
    return { config };
  });

  // ---- 手动补一轮快照（冷启动 seeding；只写 customer_snapshots，非破坏）----
  app.post('/api/customers/snapshot', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const written = await runCustomerSnapshotOnce(deps);
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'customers.snapshot.run',
      payload: { written },
      ok: true,
    });
    return { written, capturedDate: beijingTodayStr() };
  });
}
