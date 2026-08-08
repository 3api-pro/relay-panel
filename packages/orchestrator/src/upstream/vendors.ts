import { isIP } from 'node:net';
import { like } from 'drizzle-orm';
import { assertPublicUrl, isBlockedIp } from '../net/guard.js';
import type { SiteUpstreamWalletCandidate } from '../sites/service.js';
import type { Db } from '../db/client.js';
import { credentials } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { toPgTimestamp } from '../auth/sessions.js';
import {
  parseNewApiBillingUsageResponse,
  parseNewApiBillingWalletResponses,
  parseSub2ApiUsageResponse,
  type RawWalletResponse,
} from './wallet-response.js';

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
export type VendorViewSystem = VendorSystem | 'unknown';
export type VendorDiscovery = 'automatic' | 'manual' | 'automatic+override';

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
  /** 上游控制台/官网入口（root-only 页面展示）。 */
  panelUrl?: string;
  /** 该供应商的充值页入口（root-only 页面展示）。 */
  rechargeUrl?: string;
  /** 备注（面板展示，如"CC Max 主力"） */
  note?: string;
  /** 关掉则不采集（保留配置） */
  enabled?: boolean;
}

/** 对客视图（不含任何凭据） */
export interface VendorBalanceView {
  vendor: string;
  label: string;
  /** root-only 页面用于创建/编辑同源覆盖；不含路径中的凭据（写入时也拒绝 userinfo）。 */
  baseUrl: string;
  panelUrl?: string;
  rechargeUrl?: string;
  system: VendorViewSystem;
  /** 数据来源：自动发现是默认路径；旧 upstream:* 仅作为兼容覆盖。 */
  discovery: VendorDiscovery;
  /** 归并进本钱包的站点×账号来源数；手工独立配置为 0。 */
  sourceCount: number;
  /** 引擎最近一次成功生成脱敏快照的时间。 */
  snapshotAt?: string;
  /** 最近一轮刷新失败，当前数值来自上一次成功快照。 */
  stale: boolean;
  /** 真实钱包余额（已按 balanceDivisor 修正）；取不到=null，前端显示"不可用"而非 0 */
  balance: number | null;
  /** 余额是否可信取到 */
  available: boolean;
  /** 取不到时的原因（面板直接显示，便于自查） */
  unavailableReason?: string;
  /** 本月累计消耗（自然月，上游账单口径） */
  costMonthToDate: number | null;
  /** 成本是否覆盖完整；partial 绝不能被误读成完整采购成本。 */
  costCoverage: 'exact' | 'partial' | 'none';
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

/** 可回显的供应商覆盖配置；凭据永远只返回“是否已配置”。 */
export interface VendorConfigView {
  vendor: string;
  label: string;
  baseUrl: string;
  system: VendorSystem;
  userId?: string;
  balanceDivisor: number;
  note?: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasBillingKey: boolean;
  panelUrl?: string;
  rechargeUrl?: string;
}

export interface SaveVendorConfigInput {
  label: string;
  baseUrl: string;
  system: VendorSystem;
  /** 空/省略表示保留已有令牌；首次创建必须提供。 */
  apiKey?: string | undefined;
  userId?: string | undefined;
  billingKey?: string | undefined;
  balanceDivisor?: number | undefined;
  panelUrl?: string | undefined;
  rechargeUrl?: string | undefined;
  note?: string | undefined;
  enabled?: boolean | undefined;
}

export class VendorConfigInputError extends Error {}

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
      ...(typeof parsed.panelUrl === 'string' && parsed.panelUrl ? { panelUrl: parsed.panelUrl } : {}),
      ...(typeof parsed.rechargeUrl === 'string' && parsed.rechargeUrl ? { rechargeUrl: parsed.rechargeUrl } : {}),
      ...(typeof parsed.note === 'string' && parsed.note ? { note: parsed.note } : {}),
      enabled: parsed.enabled !== false,
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor));
}

function configView(config: VendorConfig): VendorConfigView {
  return {
    vendor: config.vendor,
    label: config.label,
    baseUrl: config.baseUrl,
    system: config.system,
    ...(config.userId ? { userId: config.userId } : {}),
    balanceDivisor: config.balanceDivisor ?? 1,
    ...(config.note ? { note: config.note } : {}),
    enabled: config.enabled !== false,
    hasApiKey: config.apiKey !== '',
    hasBillingKey: Boolean(config.billingKey),
    ...(config.panelUrl ? { panelUrl: config.panelUrl } : {}),
    ...(config.rechargeUrl ? { rechargeUrl: config.rechargeUrl } : {}),
  };
}

export async function readVendorConfigView(
  deps: { db: Db; secretKey?: string },
  vendor: string,
): Promise<VendorConfigView | null> {
  const found = (await readVendorConfigs(deps)).find((config) => config.vendor === vendor);
  return found ? configView(found) : null;
}

/** 加密保存自动发现条目的可选覆盖；任何响应、审计和异常都不携带令牌。 */
export async function saveVendorConfig(
  deps: { db: Db; secretKey?: string },
  vendor: string,
  input: SaveVendorConfigInput,
): Promise<VendorConfigView> {
  if (!deps.secretKey) throw new VendorConfigInputError('RP_SECRET_KEY 未配置，无法保存上游凭据');
  const ref = `${VENDOR_CRED_PREFIX}${vendor}`;
  const existing = (await readVendorConfigs(deps)).find((config) => config.vendor === vendor);
  const apiKey = input.apiKey?.trim() || existing?.apiKey || '';
  if (!apiKey) throw new VendorConfigInputError('首次保存必须填写面板令牌或 API Key');
  const normalized = input.baseUrl.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new VendorConfigInputError('上游地址格式无效');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new VendorConfigInputError('上游地址必须是无内嵌凭据的 HTTPS 地址');
  }
  try {
    await assertPublicUrl(normalized, { failClosed: true });
  } catch {
    throw new VendorConfigInputError('上游地址未通过公网安全校验');
  }
  for (const link of [input.panelUrl, input.rechargeUrl]) {
    if (!link?.trim()) continue;
    let target: URL;
    try {
      target = new URL(link.trim());
    } catch {
      throw new VendorConfigInputError('控制台或充值入口格式无效');
    }
    if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') {
      throw new VendorConfigInputError('控制台和充值入口必须是无内嵌凭据的 HTTPS 地址');
    }
  }
  const config: VendorConfig = {
    vendor,
    label: input.label.trim() || existing?.label || vendor,
    baseUrl: normalized,
    apiKey,
    system: input.system,
    ...(input.userId?.trim() ? { userId: input.userId.trim() } : {}),
    ...(input.billingKey?.trim()
      ? { billingKey: input.billingKey.trim() }
      : existing?.billingKey ? { billingKey: existing.billingKey } : {}),
    ...(existing?.costKeys?.length ? { costKeys: existing.costKeys } : {}),
    ...(input.balanceDivisor && input.balanceDivisor !== 1 ? { balanceDivisor: input.balanceDivisor } : {}),
    ...(input.panelUrl?.trim() ? { panelUrl: input.panelUrl.trim() } : {}),
    ...(input.rechargeUrl?.trim() ? { rechargeUrl: input.rechargeUrl.trim() } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    enabled: input.enabled !== false,
  };
  if (config.system === 'newapi' && !config.userId) {
    throw new VendorConfigInputError('NewAPI 真实余额查询必须填写用户 ID');
  }
  const ciphertext = encryptSecret(JSON.stringify(config), deps.secretKey);
  await deps.db.orm
    .insert(credentials)
    .values({ ref, kind: VENDOR_CRED_KIND, ciphertext })
    .onConflictDoUpdate({
      target: credentials.ref,
      set: { kind: VENDOR_CRED_KIND, ciphertext, rotatedAt: toPgTimestamp(new Date()) },
    });
  return configView(config);
}

interface ProbeResult {
  balance: number | null;
  costMonthToDate: number | null;
  costCoverage?: 'exact' | 'partial' | 'none';
  reason?: string;
}

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

async function getWalletResponse(url: string, headers: Record<string, string>): Promise<RawWalletResponse> {
  await assertPublicUrl(url, { failClosed: true });
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
  if (!res.body) throw new Error('empty_response');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('response_too_large');
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    contentType: res.headers.get('content-type'),
    body: new TextDecoder().decode(body),
  };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const raw = await getWalletResponse(url, headers);
  const mediaType = (raw.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json' && !(mediaType.startsWith('application/') && mediaType.endsWith('+json'))) {
    throw new Error('invalid_content_type');
  }
  try {
    return JSON.parse(raw.body.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}

/** 单把 key 的 /v1/usage 结果 */
async function sub2apiUsage(baseUrl: string, key: string, monthStart: string):
  Promise<{ balance: number | null; cost: number | null }> {
  const raw = await getWalletResponse(`${baseUrl}/v1/usage`, {
    Authorization: `Bearer ${key}`,
  });
  const parsed = parseSub2ApiUsageResponse(raw);
  if (parsed.protocol !== 'sub2api' || !['ok', 'partial'].includes(parsed.status)) {
    throw new Error(parsed.status);
  }
  const j = JSON.parse(raw.body.replace(/^\uFEFF/, '')) as { daily_usage?: unknown };
  const balance = parsed.balance;
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
  let partial = false;
  for (const k of cfg.costKeys ?? []) {
    try {
      const extra = await sub2apiUsage(cfg.baseUrl, k, monthStart);
      if (extra.cost !== null) cost = (cost ?? 0) + extra.cost;
    } catch {
      partial = true;
    }
  }
  return {
    balance: primary.balance,
    costMonthToDate: cost,
    costCoverage: cost === null ? 'none' : partial ? 'partial' : 'exact',
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

async function probeNewapi(cfg: VendorConfig, monthStart: string, today: string): Promise<ProbeResult> {
  // 本月成本（两条路都用得上）；账单接口用 billingKey，缺省回落主凭据
  const billingKey = cfg.billingKey ?? cfg.apiKey;
  let cost: number | null = null;
  try {
    const raw = await getWalletResponse(
      `${cfg.baseUrl}/dashboard/billing/usage?start_date=${monthStart}&end_date=${today}`,
      { Authorization: `Bearer ${billingKey}` },
    );
    const parsed = parseNewApiBillingUsageResponse(raw);
    if (parsed.status === 'ok') cost = parsed.usage;
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
      if (j.success === true && typeof q === 'number' && Number.isFinite(q)) {
        return {
          balance: q / NEWAPI_QUOTA_PER_USD,
          costMonthToDate: cost,
          costCoverage: cost === null ? 'none' : 'exact',
        };
      }
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
    const subscription = await getWalletResponse(`${cfg.baseUrl}/dashboard/billing/subscription`, {
      Authorization: `Bearer ${billingKey}`,
    });
    const lifetimeUsage = await getWalletResponse(`${cfg.baseUrl}/dashboard/billing/usage?start_date=2020-01-01&end_date=${today}`, {
      Authorization: `Bearer ${billingKey}`,
    });
    const parsed = parseNewApiBillingWalletResponses({ subscription, lifetimeUsage });
    if (parsed.status === 'placeholder_limit') {
      return { balance: null, costMonthToDate: cost, costCoverage: cost === null ? 'none' : 'exact', reason: '上游屏蔽额度(返回占位值)，需配置管理令牌+用户ID' };
    }
    if (parsed.status !== 'ok' || parsed.balance === null) {
      return { balance: null, costMonthToDate: cost, costCoverage: cost === null ? 'none' : 'exact', reason: '账单响应格式无法识别' };
    }
    return {
      balance: parsed.balance,
      costMonthToDate: cost,
      costCoverage: cost === null ? 'none' : 'exact',
    };
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
  meta: {
    discovery?: VendorDiscovery;
    sourceCount?: number;
    snapshotAt?: string;
    stale?: boolean;
    system?: VendorViewSystem;
  } = {},
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
    baseUrl: cfg.baseUrl,
    ...(cfg.panelUrl ? { panelUrl: cfg.panelUrl } : {}),
    ...(cfg.rechargeUrl ? { rechargeUrl: cfg.rechargeUrl } : {}),
    system: meta.system ?? cfg.system,
    discovery: meta.discovery ?? 'manual',
    sourceCount: meta.sourceCount ?? 0,
    ...(meta.snapshotAt ? { snapshotAt: meta.snapshotAt } : {}),
    stale: meta.stale === true,
    balance,
    available: balance !== null,
    ...(probe.reason ? { unavailableReason: probe.reason } : {}),
    costMonthToDate: probe.costMonthToDate,
    costCoverage: probe.costCoverage ?? (probe.costMonthToDate === null ? 'none' : 'exact'),
    avgDailyCost,
    daysLeft,
    low: daysLeft !== null && lowDaysThreshold > 0 && daysLeft < lowDaysThreshold,
    ...(cfg.note ? { note: cfg.note } : {}),
    balanceDivisor: divisor,
  };
}

interface ResolvedVendorSource {
  config: VendorConfig;
  candidates: SiteUpstreamWalletCandidate[];
  discovery: VendorDiscovery;
  system: VendorViewSystem;
}

/**
 * 供应商身份只取 URL origin；路径、query、fragment 和 userinfo 都不参与匹配。
 * 这让四个站里同一个 https://fuyao.shop/v1 账号自动折叠成一个钱包，同时不会把 URL 内嵌凭据带出。
 */
export function normalizeVendorOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function automaticOrigin(raw: string): string | null {
  const origin = normalizeVendorOrigin(raw);
  if (!origin) return null;
  const url = new URL(origin);
  // 自动发现只呈现公网 HTTPS 供应商。127.0.0.1/V3 等内部 relay 节点不是采购钱包，不能混进供应商卡片。
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (isIP(host) !== 0 && isBlockedIp(host)) return null;
  return origin;
}

function autoVendorId(origin: string): string {
  const url = new URL(origin);
  return `auto-${url.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function autoVendorLabel(origin: string): string {
  const host = new URL(origin).hostname.toLowerCase();
  return host.replace(/^(?:api|www)\./, '');
}

function automaticVendorLabel(
  origin: string,
  candidates: SiteUpstreamWalletCandidate[],
): string {
  const manifest = bestCandidate(candidates.filter((candidate) => candidate.siteEngine === 'manifest'));
  return manifest?.siteLabel.trim() || autoVendorLabel(origin);
}

function automaticVendorNote(candidates: SiteUpstreamWalletCandidate[]): string | undefined {
  const names = [...new Set(candidates.map((candidate) => candidate.accountName.trim()).filter(Boolean))];
  if (names.length === 0) return undefined;
  const visible = names.slice(0, 3).join(' · ');
  return names.length > 3 ? `${visible} 等 ${names.length} 个来源账号` : visible;
}

function protocolSystem(candidate: SiteUpstreamWalletCandidate): VendorViewSystem {
  if (candidate.snapshot?.protocol === 'sub2api_v1_usage') return 'sub2api';
  if (candidate.snapshot?.protocol === 'newapi_billing') return 'newapi';
  return candidate.system;
}

function candidateTime(candidate: SiteUpstreamWalletCandidate): number {
  const parsed = candidate.snapshot?.observedAt ? Date.parse(candidate.snapshot.observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotRank(candidate: SiteUpstreamWalletCandidate): number {
  const snapshot = candidate.snapshot;
  if (!snapshot) return 0;
  if (snapshot.status === 'ok' && typeof snapshot.balance === 'number' && snapshot.mode !== 'quota_limited') return 4;
  if (snapshot.status === 'ok') return 3;
  if (snapshot.status === 'failed') return 2;
  return 1;
}

function bestCandidate(candidates: SiteUpstreamWalletCandidate[]): SiteUpstreamWalletCandidate | undefined {
  return [...candidates].sort((a, b) => snapshotRank(b) - snapshotRank(a) || candidateTime(b) - candidateTime(a))[0];
}

const SNAPSHOT_REASON: Record<string, string> = {
  placeholder_limit: '已自动发现；上游只返回占位额度，真实余额需要面板令牌和用户 ID',
  missing_user_id: '已自动发现；真实余额还需要上游用户 ID',
  needs_user_id: '已自动发现；真实余额还需要上游用户 ID',
  credential_not_exported: '已自动发现；引擎不会导出该渠道密钥，暂时无法自动读取钱包余额',
  no_credentials: '已自动发现；当前运行实例没有可用于只读账单查询的渠道凭据',
  auth_failed: '已自动发现；上游余额凭据无效或已过期',
  credential_invalid: '已自动发现；上游余额凭据无效或已过期',
  credential_rejected: '已自动发现；上游余额凭据无效或无账单读取权限',
  blocked_target: '已自动发现；目标地址未通过安全校验',
  invalid_base_url: '已自动发现；上游地址格式无效',
  insecure_base_url: '已自动发现；上游地址不是 HTTPS，已拒绝自动探测',
  redirect_blocked: '已自动发现；上游账单接口发生重定向，已按安全策略拒绝跟随',
  timeout: '已自动发现；上游余额接口暂时超时',
  request_failed: '已自动发现；上游余额接口暂时不可达',
  network_error: '已自动发现；上游余额接口暂时不可达',
  rate_limited: '已自动发现；上游账单接口触发限流，将自动重试',
  upstream_error: '已自动发现；上游账单服务暂时异常，将自动重试',
  response_too_large: '已自动发现；上游账单响应超过安全上限',
  invalid_payload: '已自动发现；上游账单响应格式无法识别',
  invalid_response: '已自动发现；上游账单响应格式无法识别',
  invalid_content_type: '已自动发现；上游账单接口没有返回 JSON',
  invalid_json: '已自动发现；上游账单接口返回了无效 JSON',
  schema_mismatch: '已自动发现；上游账单响应格式无法识别',
  invalid_number: '已自动发现；上游账单金额字段无效',
  ambiguous_protocol: '已自动发现；上游同时匹配多种账单协议，已拒绝采用不确定余额',
  endpoint_not_found: '已自动发现；上游没有可用的只读余额接口',
  unsupported_protocol: '已自动发现；上游没有可用的只读余额接口',
  balance_unavailable: '已自动发现；账单接口未返回真实钱包余额',
};

function snapshotProbeOne(candidates: SiteUpstreamWalletCandidate[]): {
  probe: ProbeResult;
  snapshotAt?: string;
  stale: boolean;
  system: VendorViewSystem;
} {
  const candidate = bestCandidate(candidates);
  if (!candidate?.snapshot) {
    return {
      probe: { balance: null, costMonthToDate: null, costCoverage: 'none', reason: '已自动发现，等待引擎生成钱包快照' },
      stale: false,
      system: candidate?.system ?? 'unknown',
    };
  }
  const snapshot = candidate.snapshot;
  const system = protocolSystem(candidate);
  const snapshotAt = snapshot.observedAt;
  if (snapshot.status !== 'ok') {
    const reason = SNAPSHOT_REASON[snapshot.reasonCode ?? ''] ?? (snapshot.status === 'unsupported'
      ? '已自动发现；上游没有可用的只读余额接口'
      : '已自动发现；本轮余额探测失败，将自动重试');
    return {
      probe: { balance: null, costMonthToDate: null, costCoverage: 'none', reason },
      ...(snapshotAt ? { snapshotAt } : {}),
      stale: snapshot.stale === true,
      system,
    };
  }
  const balance = snapshot.mode !== 'quota_limited' && typeof snapshot.balance === 'number'
    ? snapshot.balance
    : null;
  const cost = typeof snapshot.costMonthToDate === 'number' ? snapshot.costMonthToDate : null;
  return {
    probe: {
      balance,
      costMonthToDate: cost,
      costCoverage: snapshot.costCoverage ?? (cost === null ? 'none' : 'exact'),
      ...(balance === null
        ? { reason: snapshot.mode === 'quota_limited'
          ? '已自动发现；上游仅返回渠道配额，不把它冒充钱包余额'
          : '已自动发现；账单接口未返回真实钱包余额' }
        : {}),
    },
    ...(snapshotAt ? { snapshotAt } : {}),
    stale: snapshot.stale === true,
    system,
  };
}

/**
 * 同名账号跨站镜像只计一次；同一供应商的不同账号名视为不同 key，成本相加、钱包余额仍只取最新一份。
 * 这是没有明文 key/跨站指纹时最保守的去重边界：避免四站镜像把成本乘四，也不漏掉明确不同的采购 key。
 */
export function snapshotProbe(candidates: SiteUpstreamWalletCandidate[]): {
  probe: ProbeResult;
  snapshotAt?: string;
  stale: boolean;
  system: VendorViewSystem;
} {
  const byAccount = new Map<string, SiteUpstreamWalletCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.accountName.trim().toLowerCase() || `id:${candidate.accountId}`;
    const group = byAccount.get(key) ?? [];
    group.push(candidate);
    byAccount.set(key, group);
  }
  const representatives = [...byAccount.values()].map((group) => snapshotProbeOne(group));
  const balanceSource = representatives
    .filter((item) => item.probe.balance !== null)
    .sort((a, b) => Date.parse(b.snapshotAt ?? '') - Date.parse(a.snapshotAt ?? ''))[0];
  const reasonSource = balanceSource ?? representatives
    .sort((a, b) => Date.parse(b.snapshotAt ?? '') - Date.parse(a.snapshotAt ?? ''))[0];
  if (!reasonSource) {
    return {
      probe: { balance: null, costMonthToDate: null, costCoverage: 'none', reason: '已自动发现，等待引擎生成钱包快照' },
      stale: false,
      system: 'unknown',
    };
  }

  const costs = representatives.filter((item) => item.probe.costMonthToDate !== null);
  const costMonthToDate = costs.length === 0
    ? null
    : costs.reduce((sum, item) => sum + (item.probe.costMonthToDate ?? 0), 0);
  const costCoverage = costMonthToDate === null
    ? 'none'
    : costs.length === representatives.length && representatives.every((item) => item.probe.costCoverage === 'exact')
      ? 'exact'
      : 'partial';
  const newestSnapshotAt = representatives
    .map((item) => item.snapshotAt)
    .filter((value): value is string => typeof value === 'string')
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return {
    probe: {
      balance: balanceSource?.probe.balance ?? null,
      costMonthToDate,
      costCoverage,
      ...(!balanceSource && reasonSource.probe.reason
        ? { reason: reasonSource.probe.reason }
        : {}),
    },
    ...(newestSnapshotAt ? { snapshotAt: newestSnapshotAt } : {}),
    stale: representatives.some((item) => item.stale),
    system: balanceSource?.system ?? reasonSource.system,
  };
}

/**
 * 自动来源是主数据，upstream:* 仅按相同 origin 覆盖展示名/口径并兼容旧探测。
 * enabled:false 的同源旧配置显式隐藏自动卡片，保留既有“停用”语义。
 */
export function resolveVendorSources(
  configs: VendorConfig[],
  candidates: SiteUpstreamWalletCandidate[],
): ResolvedVendorSource[] {
  const automatic = new Map<string, SiteUpstreamWalletCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.enabled) continue;
    const origin = automaticOrigin(candidate.baseUrl);
    if (!origin) continue;
    const group = automatic.get(origin) ?? [];
    group.push(candidate);
    automatic.set(origin, group);
  }

  const manualByOrigin = new Map<string, VendorConfig[]>();
  for (const config of configs) {
    const origin = normalizeVendorOrigin(config.baseUrl);
    if (!origin) continue;
    const group = manualByOrigin.get(origin) ?? [];
    group.push(config);
    manualByOrigin.set(origin, group);
  }

  const matched = new Set<VendorConfig>();
  const resolved: ResolvedVendorSource[] = [];
  for (const [origin, group] of automatic) {
    const overrides = manualByOrigin.get(origin) ?? [];
    for (const config of overrides) matched.add(config);
    if (overrides.some((config) => config.enabled === false)) continue;
    const override = overrides.find((config) => config.enabled !== false);
    const best = bestCandidate(group);
    const detectedSystem = best ? protocolSystem(best) : 'unknown';
    const system = detectedSystem === 'unknown' && override ? override.system : detectedSystem;
    const autoNote = automaticVendorNote(group);
    const config: VendorConfig = override
      ? { ...override, ...(override.note ? {} : autoNote ? { note: autoNote } : {}) }
      : {
          vendor: autoVendorId(origin),
          label: automaticVendorLabel(origin, group),
          baseUrl: origin,
          apiKey: '',
          system: system === 'newapi' ? 'newapi' : 'sub2api',
          ...(autoNote ? { note: autoNote } : {}),
          enabled: true,
        };
    resolved.push({
      config,
      candidates: group,
      discovery: override ? 'automatic+override' : 'automatic',
      system,
    });
  }

  for (const config of configs) {
    if (matched.has(config) || config.enabled === false) continue;
    resolved.push({ config, candidates: [], discovery: 'manual', system: config.system });
  }
  return resolved;
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
  deps: {
    db: Db;
    secretKey?: string;
    discover?: (opts: { force: boolean }) => Promise<SiteUpstreamWalletCandidate[]>;
  },
  opts: { lowDaysThreshold?: number; force?: boolean } = {},
): Promise<VendorOverview> {
  const lowDays = opts.lowDaysThreshold ?? DEFAULT_LOW_DAYS;
  const cached = vendorCache.get(CACHE_KEY);
  if (!opts.force && cached && Date.now() - cached.at < VENDOR_TTL_MS) return cached.body;

  const now = new Date();
  const configs = await readVendorConfigs(deps);
  let candidates: SiteUpstreamWalletCandidate[] = [];
  if (deps.discover) {
    try {
      candidates = await deps.discover({ force: opts.force === true });
    } catch {
      // 自动发现整体失败时保留旧 upstream:* 兼容路径，不让供应商页整页报错。
    }
  }
  const sources = resolveVendorSources(configs, candidates);
  const rows = await Promise.all(
    sources.map(async (source) => {
      if (source.candidates.length === 0) {
        return buildVendorView(source.config, await probeVendor(source.config, now), lowDays, now, {
          discovery: 'manual',
          sourceCount: 0,
          system: source.system,
        });
      }

      const automatic = snapshotProbe(source.candidates);
      let probe = automatic.probe;
      // 旧配置里若有独立面板凭据，而引擎快照暂时拿不到真实余额，继续用它补齐；
      // 一旦引擎已有真实快照便不再把上游 key 搬进面板探测链路。
      if (probe.balance === null && source.discovery === 'automatic+override' && source.config.apiKey !== '') {
        const fallback = await probeVendor(source.config, now);
        if (fallback.balance !== null || fallback.costMonthToDate !== null) {
          const costCoverage = fallback.costMonthToDate !== null ? fallback.costCoverage : probe.costCoverage;
          probe = {
            balance: fallback.balance ?? probe.balance,
            costMonthToDate: fallback.costMonthToDate ?? probe.costMonthToDate,
            ...(costCoverage ? { costCoverage } : {}),
            ...(fallback.balance === null && fallback.reason ? { reason: fallback.reason } : {}),
          };
        }
      }
      return buildVendorView(source.config, probe, lowDays, now, {
        discovery: source.discovery,
        sourceCount: source.candidates.length,
        ...(automatic.snapshotAt ? { snapshotAt: automatic.snapshotAt } : {}),
        stale: automatic.stale,
        system: automatic.system === 'unknown' ? source.system : automatic.system,
      });
    }),
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
