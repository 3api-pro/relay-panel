import type {
  ChannelRecord,
  GroupRecord,
  SiteBranding,
  SiteUserRecord,
  UsageSummary,
} from '@relay-panel/adapter-core';

/**
 * 演示模式的确定性罐装数据生成器（安全第一：纯本地计算，零网络、零凭据、零真实品牌）。
 *
 * 所有数据以 site slug 做种子生成：同一 slug 每次进程内/跨重启都得到稳定结果，
 * 便于演示页面反复刷新看到一致画面。渠道 apiKey 恒 '<redacted>'，绝不出现任何真实
 * 上游供应商名/真实站名/真实密钥——名字一律用对外中性词。
 */

// ---------------------------------------------------------------------------
// 确定性伪随机：slug -> 32bit 种子 -> mulberry32 序列
// ---------------------------------------------------------------------------

/** djb2 字符串哈希，稳定跨平台 */
export function hashSlug(slug: string): number {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h + slug.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：给定种子的确定性 [0,1) 生成器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 简易确定性随机器：整数区间 / 数组取样 / 概率 */
class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** [min,max] 闭区间整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  /** 命中概率 p */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

function rngFor(slug: string, salt: string): Rng {
  return new Rng(hashSlug(`${slug}:${salt}`));
}

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

const GROUP_POOL: { name: string; ratio: number; description: string }[] = [
  { name: '默认', ratio: 1.0, description: '标准计费分组' },
  { name: '高级', ratio: 2.0, description: '高优先级 + 更高倍率' },
  { name: '团队', ratio: 1.5, description: '团队共享额度' },
  { name: '体验', ratio: 0.5, description: '试用体验半价' },
];

export function demoGroups(slug: string): GroupRecord[] {
  const rng = rngFor(slug, 'groups');
  const count = rng.int(2, 4);
  return GROUP_POOL.slice(0, count).map((g, i) => ({
    id: String(i + 1),
    name: g.name,
    ratio: g.ratio,
    description: g.description,
  }));
}

// ---------------------------------------------------------------------------
// 渠道
// ---------------------------------------------------------------------------

const CHANNEL_POOL: { name: string; protocol: ChannelRecord['protocol']; models: string[] }[] = [
  { name: 'Claude 主力', protocol: 'anthropic', models: ['claude-sonnet', 'claude-opus'] },
  { name: 'Claude 备用', protocol: 'anthropic', models: ['claude-sonnet'] },
  { name: 'GPT 主力', protocol: 'openai', models: ['gpt-omni', 'gpt-mini'] },
  { name: 'GPT 备用', protocol: 'openai-responses', models: ['gpt-omni'] },
  { name: 'Gemini 视觉', protocol: 'gemini', models: ['gemini-pro-vision'] },
  { name: 'Gemini 长文', protocol: 'gemini', models: ['gemini-pro'] },
  { name: '国产大模型', protocol: 'openai', models: ['domestic-chat', 'domestic-plus'] },
  { name: '推理增强', protocol: 'openai', models: ['reasoner-max'] },
];

export function demoChannels(slug: string): ChannelRecord[] {
  const rng = rngFor(slug, 'channels');
  const count = rng.int(3, 8);
  return CHANNEL_POOL.slice(0, count).map((c, i) => ({
    id: String(i + 1),
    name: c.name,
    protocol: c.protocol,
    // 内部地址仅演示占位，绝不暴露真实上游供应商
    baseUrl: 'https://upstream.internal/v1',
    apiKey: '<redacted>' as const,
    models: c.models,
    // 多数启用，个别停用让画面真实
    enabled: !(i > 0 && rng.chance(0.18)),
    priority: rng.int(0, 5),
    weight: rng.int(1, 10),
  }));
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

const USER_PREFIXES = [
  'alex', 'sam', 'jordan', 'taylor', 'casey', 'morgan', 'riley', 'jamie',
  'chris', 'dana', 'lee', 'robin', 'sky', 'quinn', 'avery', 'parker',
];

export function demoUsers(slug: string): SiteUserRecord[] {
  const rng = rngFor(slug, 'users');
  const count = rng.int(20, 80);
  const users: SiteUserRecord[] = [];
  for (let i = 0; i < count; i++) {
    const prefix = USER_PREFIXES[i % USER_PREFIXES.length]!;
    const n = String(i + 1).padStart(3, '0');
    const username = `${prefix}${n}`;
    const isAdmin = i === 0 || rng.chance(0.06);
    users.push({
      id: String(i + 1),
      email: `${username}@demo-user.example`,
      username,
      role: isAdmin ? 'admin' : 'user',
      // 余额单位仅演示，随机分布
      balance: rng.int(0, 50000) / 100,
      status: rng.chance(0.9) ? 'active' : 'disabled',
    });
  }
  return users;
}

// ---------------------------------------------------------------------------
// 品牌
// ---------------------------------------------------------------------------

export function demoBranding(_slug: string, siteName: string): SiteBranding {
  return {
    siteName,
    announcement: '这是一个只读演示环境，数据均为随机生成，随时可能重置。',
  };
}

// ---------------------------------------------------------------------------
// 用量：按天平滑起伏曲线（工作日高 / 周末低），供 14 天 AreaChart 好看
// ---------------------------------------------------------------------------

const MODEL_SPLIT: { model: string; share: number; priceIn: number; priceOut: number }[] = [
  { model: 'claude-sonnet', share: 0.45, priceIn: 3, priceOut: 15 },
  { model: 'gpt-omni', share: 0.3, priceIn: 2.5, priceOut: 10 },
  { model: 'gemini-pro', share: 0.15, priceIn: 1.25, priceOut: 5 },
  { model: 'domestic-chat', share: 0.1, priceIn: 0.5, priceOut: 2 },
];

const DAY_MS = 86_400_000;

/** 某一天(UTC)的负载系数：工作日高、周末低，叠加缓慢正弦波与确定性噪声 */
function dayFactor(slug: string, dayIndex: number): number {
  const dow = new Date(dayIndex * DAY_MS).getUTCDay(); // 0=周日 6=周六
  const weekend = dow === 0 || dow === 6;
  const base = weekend ? 0.55 : 1.0;
  const wave = 1 + 0.15 * Math.sin(dayIndex / 3.3);
  // 确定性噪声 ±0.12
  const noise = 0.88 + rngFor(slug, `day:${dayIndex}`).float() * 0.24;
  return base * wave * noise;
}

/** 站点基线日请求数（不同站规模不同） */
function siteBaseRequests(slug: string): number {
  return rngFor(slug, 'scale').int(2000, 9000);
}

interface DayUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  byModel: Record<string, { requests: number; tokens: number; cost: number }>;
}

/** 计算单个 UTC 天的用量（确定性） */
function usageForDay(slug: string, dayIndex: number): DayUsage {
  const rng = rngFor(slug, `usage:${dayIndex}`);
  const requests = Math.max(1, Math.round(siteBaseRequests(slug) * dayFactor(slug, dayIndex)));
  // 每请求平均 token（略有抖动）
  const avgIn = rng.int(800, 1500);
  const avgOut = rng.int(400, 900);

  const byModel: Record<string, { requests: number; tokens: number; cost: number }> = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let cost = 0;
  let allocated = 0;

  MODEL_SPLIT.forEach((m, idx) => {
    const isLast = idx === MODEL_SPLIT.length - 1;
    const mReq = isLast ? requests - allocated : Math.round(requests * m.share);
    allocated += mReq;
    const mIn = mReq * avgIn;
    const mOut = mReq * avgOut;
    const mCost = (mIn / 1_000_000) * m.priceIn + (mOut / 1_000_000) * m.priceOut;
    promptTokens += mIn;
    completionTokens += mOut;
    cost += mCost;
    byModel[m.model] = {
      requests: mReq,
      tokens: mIn + mOut,
      cost: Math.round(mCost * 100) / 100,
    };
  });

  return {
    requests,
    promptTokens,
    completionTokens,
    cost: Math.round(cost * 100) / 100,
    byModel,
  };
}

/**
 * 任意窗口 [from,to) 的用量汇总：按覆盖到的每个 UTC 天求和。
 * 面板 usageSeries 逐天调用（单日窗口 → 单天），probe 用 24h 窗口（单天），
 * 都能得到平滑有起伏的确定性曲线。
 */
export function demoUsage(slug: string, from: Date, to: Date): UsageSummary {
  const startDay = Math.floor(from.getTime() / DAY_MS);
  const endDay = Math.ceil(to.getTime() / DAY_MS);
  const total: DayUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    byModel: {},
  };
  for (let d = startDay; d < endDay; d++) {
    const day = usageForDay(slug, d);
    total.requests += day.requests;
    total.promptTokens += day.promptTokens;
    total.completionTokens += day.completionTokens;
    total.cost += day.cost;
    for (const [model, v] of Object.entries(day.byModel)) {
      const agg = total.byModel[model] ?? { requests: 0, tokens: 0, cost: 0 };
      agg.requests += v.requests;
      agg.tokens += v.tokens;
      agg.cost = Math.round((agg.cost + v.cost) * 100) / 100;
      total.byModel[model] = agg;
    }
  }
  return {
    from,
    to,
    requests: total.requests,
    promptTokens: total.promptTokens,
    completionTokens: total.completionTokens,
    costUnit: 'USD',
    cost: Math.round(total.cost * 100) / 100,
    byModel: total.byModel,
  };
}
