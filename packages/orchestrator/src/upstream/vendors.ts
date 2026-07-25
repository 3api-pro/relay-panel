import { eq, like } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { credentials } from '../db/schema.js';
import { decryptSecret } from '../secrets.js';

/**
 * 上游【供应商】钱包视图（2026-07-25 新增，与同目录 service.ts 的「站点×渠道」视图并存、互不影响）。
 *
 * 为什么要这一层：service.ts 的 /balances 是**按我方站点分组**的——同一家上游（如 voltapi）被 4 个站
 * 共用时会重复出现 4 行，且它走的是各站引擎 admin API 的 quota 口径，**拿不到上游钱包真实余额**
 * （见 service.ts 顶部铁律）。老板要的是「我在每一家上游那里还剩多少钱」，是**采购视角**，
 * 与「某站某渠道配了多少额度」是两回事。
 *
 * 本模块直连上游自己的账单接口取**真实钱包余额**，按供应商折叠成一行。两大系统：
 *  - sub2api 系（voltapi / ai1api / goforai / 55ai）：GET {base}/v1/usage
 *      → { balance, daily_usage:[{date,cost,actual_cost,...}] }，balance 即真实余额。
 *  - newapi 系（nexaxis / aizhongzhuan）：
 *      · 首选 GET {base}/api/user/self → data.quota（需管理令牌 + New-Api-User 头）；
 *        quota 是 newapi 内部单位，÷500000 = USD。
 *      · 回退 GET {base}/dashboard/billing/subscription 的 hard_limit_usd − 累计 total_usage/100
 *        （sk key 即可，但部分上游把 hard_limit 返回 1e8 占位 → 此路不通，必须配管理令牌）。
 *
 * 🔴 口径诚实：拿不到就是 null（unavailable），**绝不用额度上限/占位值冒充余额**。
 * 🔴 balanceDivisor：个别上游站点把余额显示成真实值的 N 倍（aizhongzhuan = 10 倍，老板 2026-07-25 核对），
 *    按供应商配置修正，避免面板显示与实际差一个数量级。
 * 🔴 凭据只在内存流转：apiKey/token 绝不进返回体、日志、审计。
 *
 * 金额单位 USD（本行业 USD:RMB 1:1，无汇率），与 service.ts 一致。
 */

/** credentials 表里上游供应商配置的 ref 前缀（与站点凭据 enc:<slug> 隔离） */
export const VENDOR_CRED_PREFIX = 'upstream:';
/** credentials.kind 取值 */
export const VENDOR_CRED_KIND = 'upstream-vendor';

/** 上游账单系统类型 */
export type VendorSystem = 'sub2api' | 'newapi';

/** 解密后的供应商配置（明文，仅内存） */
export interface VendorConfig {
  /** 供应商标识（voltapi / ai1api / ...），= ref 去掉前缀 */
  vendor: string;
  /** 展示名 */
  label: string;
  /** 账单接口 base（无尾斜杠） */
  baseUrl: string;
  /** 主凭据：sub2api 系=sk key；newapi 系=面板管理令牌（配合 userId 取余额） */
  apiKey: string;
  system: VendorSystem;
  /** newapi 系必需：New-Api-User 头的用户 ID */
  userId?: string;
  /**
   * 仅 newapi 系可选：专供 /dashboard/billing/usage 的 sk key。
   * 有些上游的**管理令牌打不了账单接口、sk key 又拿不到余额**，两者需要分开。缺省回落 apiKey。
   */
  billingKey?: string;
  /**
   * 仅 sub2api 系：同一家上游在我方开了多把 key（如 voltapi 的 CC Max / Codex-std / Codex-low / Bedrock）时，
   * **钱包是共享的、账单却是按 key 分别记的**。余额取 apiKey 一次即可，成本必须把每把 key 的
   * daily_usage 累加，否则严重低估（实测 voltapi 只取一把 = 少算 60%）。此处放除 apiKey 外的其余 key。
   */
  costKeys?: string[];
  /**
   * 余额显示修正系数：上游站点显示值 ÷ divisor = 真实余额。默认 1。
   * aizhongzhuan = 10（其面板把余额放大了 10 倍）。
   */
  balanceDivisor?: number;
  /** 备注（面板展示，如"CC Max 主力"） */
  note?: string;
  /** 关掉则不采集（保留配置） */
  enabled?: boolean;
}

/** 对客视图（不含任何凭据） */
export interface VendorBalanceView {
  vendor: string;
  label: string;
  system: VendorSystem;
  /** 真实钱包余额（已按 balanceDivisor 修正）；取不到=null，前端显示"不可用"而非 0 */
  balance: number | null;
  /** 余额是否可信取到 */
  available: boolean;
  /** 取不到时的原因（面板直接显示，便于自查） */
  unavailableReason?: string;
  /** 本月累计消耗（自然月，上游账单口径） */
  costMonthToDate: number | null;
  /** 日均消耗（本月累计 ÷ 已过天数） */
  avgDailyCost: number | null;
  /** 还能撑几天 = balance / avgDailyCost；任一为 null 或日均<=0 → null（不编造） */
  daysLeft: number | null;
  /** 低余额红标：daysLeft 有值且 < lowDaysThreshold */
  low: boolean;
  note?: string;
  /** 应用的显示修正系数（!=1 时前端标注，避免"面板和上游站点对不上"的困惑） */
  balanceDivisor: number;
}

export interface VendorOverview {
  rows: VendorBalanceView[];
  /** 可采集到余额的供应商数 / 总数 */
  withBalance: number;
  total: number;
  /** 本月上游总成本（可采集部分之和） */
  totalCostMonthToDate: number;
  /** 判定 low 的天数阈值 */
  lowDaysThreshold: number;
  costUnit: 'USD';
  /** 采集时刻 ISO（前端显示"数据截至"） */
  fetchedAt: string;
}

/** 本月已过天数（含今天，按 Asia/Shanghai），用于把"本月累计"折算成日均 */
export function beijingDayOfMonth(now: Date = new Date()): number {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return bj.getUTCDate();
}

/** 本月首日 YYYY-MM-DD（Asia/Shanghai） */
export function beijingMonthStart(now: Date = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** 今日 YYYY-MM-DD（Asia/Shanghai） */
export function beijingToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * daysLeft：余额 ÷ 日均。任一缺失或日均<=0 → null（与 service.ts 的 computeDaysLeft 同哲学：不编造）。
 */
export function computeVendorDaysLeft(balance: number | null, avgDailyCost: number | null): number | null {
  if (balance === null || avgDailyCost === null) return null;
  if (!(avgDailyCost > 0)) return null;
  return balance / avgDailyCost;
}

/** 从 credentials 表读所有上游供应商配置（解密）。secretKey 缺失 → 空数组（功能优雅降级） */
export async function readVendorConfigs(deps: { db: Db; secretKey?: string }): Promise<VendorConfig[]> {
  if (!deps.secretKey) return [];
  const rows = await deps.db.orm
    .select({ ref: credentials.ref, ciphertext: credentials.ciphertext })
    .from(credentials)
    .where(like(credentials.ref, `${VENDOR_CRED_PREFIX}%`));
  const out: VendorConfig[] = [];
  for (const r of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(decryptSecret(r.ciphertext, deps.secretKey)) as Record<string, unknown>;
    } catch {
      continue; // 解不开/坏行：跳过，不让一条坏配置打挂整页
    }
    const vendor = r.ref.slice(VENDOR_CRED_PREFIX.length);
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.replace(/\/+$/, '') : '';
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
    const system = parsed.system === 'newapi' ? 'newapi' : 'sub2api';
    if (!vendor || !baseUrl || !apiKey) continue;
    out.push({
      vendor,
      label: typeof parsed.label === 'string' && parsed.label ? parsed.label : vendor,
      baseUrl,
      apiKey,
      system,
      ...(typeof parsed.userId === 'string' && parsed.userId ? { userId: parsed.userId } : {}),
      ...(typeof parsed.billingKey === 'string' && parsed.billingKey ? { billingKey: parsed.billingKey } : {}),
      ...(Array.isArray(parsed.costKeys) && parsed.costKeys.length
        ? { costKeys: (parsed.costKeys as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '') }
        : {}),
      ...(typeof parsed.balanceDivisor === 'number' && parsed.balanceDivisor > 0
        ? { balanceDivisor: parsed.balanceDivisor }
        : {}),
      ...(typeof parsed.note === 'string' && parsed.note ? { note: parsed.note } : {}),
      enabled: parsed.enabled !== false,
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor));
}

interface ProbeResult {
  balance: number | null;
  costMonthToDate: number | null;
  reason?: string;
}

const TIMEOUT_MS = 15_000;

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

/** 单把 key 的 /v1/usage 结果 */
async function sub2apiUsage(baseUrl: string, key: string, monthStart: string):
  Promise<{ balance: number | null; cost: number | null }> {
  const j = (await getJson(`${baseUrl}/v1/usage`, {
    'x-api-key': key,
    Authorization: `Bearer ${key}`,
  })) as { balance?: unknown; daily_usage?: unknown };
  const balance = typeof j.balance === 'number' ? j.balance : null;
  let cost: number | null = null;
  if (Array.isArray(j.daily_usage)) {
    cost = 0;
    for (const d of j.daily_usage as Array<{ date?: unknown; cost?: unknown }>) {
      if (typeof d.date === 'string' && d.date >= monthStart && typeof d.cost === 'number') cost += d.cost;
    }
  }
  return { balance, cost };
}

/**
 * sub2api 系：GET /v1/usage → balance + daily_usage[].cost。
 * 余额取主 key 一次（同家多 key 共享钱包）；成本把 apiKey + costKeys 全部累加（账单按 key 分记）。
 */
async function probeSub2api(cfg: VendorConfig, monthStart: string): Promise<ProbeResult> {
  const primary = await sub2apiUsage(cfg.baseUrl, cfg.apiKey, monthStart);
  let cost = primary.cost;
  for (const k of cfg.costKeys ?? []) {
    try {
      const extra = await sub2apiUsage(cfg.baseUrl, k, monthStart);
      if (extra.cost !== null) cost = (cost ?? 0) + extra.cost;
    } catch {
      /* 单把辅助 key 取不到不影响余额与其余成本 */
    }
  }
  return {
    balance: primary.balance,
    costMonthToDate: cost,
    ...(primary.balance === null ? { reason: '接口未返回 balance' } : {}),
  };
}

/**
 * newapi 系：
 *  首选 /api/user/self（需管理令牌 + New-Api-User），data.quota ÷ 500000 = USD；
 *  回退 /dashboard/billing/subscription 的 hard_limit_usd − 累计已用（sk key 即可）。
 *  hard_limit_usd >= 1e8 视为上游屏蔽额度的占位值 → 余额判定为不可用（绝不当成"有一亿"）。
 */
const NEWAPI_QUOTA_PER_USD = 500_000;
const NEWAPI_PLACEHOLDER_LIMIT = 1e8;

async function probeNewapi(cfg: VendorConfig, monthStart: string, today: string): Promise<ProbeResult> {
  // 本月成本（两条路都用得上）；账单接口用 billingKey，缺省回落主凭据
  const billingKey = cfg.billingKey ?? cfg.apiKey;
  let cost: number | null = null;
  try {
    const u = (await getJson(
      `${cfg.baseUrl}/dashboard/billing/usage?start_date=${monthStart}&end_date=${today}`,
      { Authorization: `Bearer ${billingKey}` },
    )) as { total_usage?: unknown };
    if (typeof u.total_usage === 'number') cost = u.total_usage / 100;
  } catch {
    /* 成本取不到不影响余额 */
  }

  if (cfg.userId) {
    try {
      const j = (await getJson(`${cfg.baseUrl}/api/user/self`, {
        Authorization: `Bearer ${cfg.apiKey}`,
        'New-Api-User': cfg.userId,
      })) as { success?: unknown; data?: { quota?: unknown } };
      const q = j.data?.quota;
      if (typeof q === 'number') return { balance: q / NEWAPI_QUOTA_PER_USD, costMonthToDate: cost };
    } catch (e) {
      return {
        balance: null,
        costMonthToDate: cost,
        reason: `管理令牌取余额失败(${e instanceof Error ? e.message : 'error'})`,
      };
    }
  }

  // 回退：额度上限 − 累计已用（用 billingKey，sk key 即可）
  try {
    const s = (await getJson(`${cfg.baseUrl}/dashboard/billing/subscription`, {
      Authorization: `Bearer ${billingKey}`,
    })) as { hard_limit_usd?: unknown };
    const limit = s.hard_limit_usd;
    if (typeof limit !== 'number') return { balance: null, costMonthToDate: cost, reason: '接口未返回额度' };
    if (limit >= NEWAPI_PLACEHOLDER_LIMIT) {
      return { balance: null, costMonthToDate: cost, reason: '上游屏蔽额度(返回占位值)，需配置管理令牌+用户ID' };
    }
    const ua = (await getJson(`${cfg.baseUrl}/dashboard/billing/usage?start_date=2020-01-01&end_date=${today}`, {
      Authorization: `Bearer ${billingKey}`,
    })) as { total_usage?: unknown };
    const usedAll = typeof ua.total_usage === 'number' ? ua.total_usage / 100 : 0;
    return { balance: limit - usedAll, costMonthToDate: cost };
  } catch (e) {
    return { balance: null, costMonthToDate: cost, reason: e instanceof Error ? e.message : '账单接口不可达' };
  }
}

/** 单供应商采集（异常一律收敛成 unavailable，绝不让一家挂掉整页） */
export async function probeVendor(cfg: VendorConfig, now: Date = new Date()): Promise<ProbeResult> {
  const monthStart = beijingMonthStart(now);
  const today = beijingToday(now);
  try {
    return cfg.system === 'newapi'
      ? await probeNewapi(cfg, monthStart, today)
      : await probeSub2api(cfg, monthStart);
  } catch (e) {
    return { balance: null, costMonthToDate: null, reason: e instanceof Error ? e.message : '不可达' };
  }
}

/** 把采集结果装配成对客视图（纯函数，便于单测） */
export function buildVendorView(
  cfg: VendorConfig,
  probe: ProbeResult,
  lowDaysThreshold: number,
  now: Date = new Date(),
): VendorBalanceView {
  const divisor = cfg.balanceDivisor ?? 1;
  const balance = probe.balance === null ? null : probe.balance / divisor;
  const dayOfMonth = beijingDayOfMonth(now);
  const avgDailyCost =
    probe.costMonthToDate === null || dayOfMonth <= 0 ? null : probe.costMonthToDate / dayOfMonth;
  const daysLeft = computeVendorDaysLeft(balance, avgDailyCost);
  return {
    vendor: cfg.vendor,
    label: cfg.label,
    system: cfg.system,
    balance,
    available: balance !== null,
    ...(probe.reason ? { unavailableReason: probe.reason } : {}),
    costMonthToDate: probe.costMonthToDate,
    avgDailyCost,
    daysLeft,
    low: daysLeft !== null && lowDaysThreshold > 0 && daysLeft < lowDaysThreshold,
    ...(cfg.note ? { note: cfg.note } : {}),
    balanceDivisor: divisor,
  };
}

/** 采集结果缓存（与 sites 侧一致的 5min TTL，避免每次刷新都打上游账单接口） */
const vendorCache = new Map<string, { at: number; body: VendorOverview }>();
const VENDOR_TTL_MS = 5 * 60_000;
const CACHE_KEY = 'vendors';

/** 低余额阈值：还能撑几天低于此值即红标 */
export const DEFAULT_LOW_DAYS = 3;

/**
 * 跨供应商采集总入口：并发探测 + 5min 缓存。
 * force=true 跳过缓存（前端"刷新"按钮用）。
 */
export async function listVendorBalances(
  deps: { db: Db; secretKey?: string },
  opts: { lowDaysThreshold?: number; force?: boolean } = {},
): Promise<VendorOverview> {
  const lowDays = opts.lowDaysThreshold ?? DEFAULT_LOW_DAYS;
  const cached = vendorCache.get(CACHE_KEY);
  if (!opts.force && cached && Date.now() - cached.at < VENDOR_TTL_MS) return cached.body;

  const now = new Date();
  const configs = (await readVendorConfigs(deps)).filter((c) => c.enabled !== false);
  const rows = await Promise.all(
    configs.map(async (cfg) => buildVendorView(cfg, await probeVendor(cfg, now), lowDays, now)),
  );
  // 排序：先红标，再按"还能撑几天"升序（最急的在最上面），无数据的沉底
  rows.sort((a, b) => {
    if (a.low !== b.low) return a.low ? -1 : 1;
    if (a.daysLeft === null && b.daysLeft === null) return a.vendor.localeCompare(b.vendor);
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });
  const body: VendorOverview = {
    rows,
    withBalance: rows.filter((r) => r.available).length,
    total: rows.length,
    totalCostMonthToDate: rows.reduce((s, r) => s + (r.costMonthToDate ?? 0), 0),
    lowDaysThreshold: lowDays,
    costUnit: 'USD',
    fetchedAt: now.toISOString(),
  };
  vendorCache.set(CACHE_KEY, { at: Date.now(), body });
  return body;
}

/** 测试/运维用：清缓存 */
export function clearVendorCache(): void {
  vendorCache.clear();
}
