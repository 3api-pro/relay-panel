/**
 * 手写内存滑窗限速（开放注册前置闸 §3，零依赖，单实例足够；本仓先例=支付网关手写）。
 *
 * 每个 key 维护一串命中时间戳；判定时先裁剪窗口外的旧戳，再比计数。
 * 惰性 + 定期全量清扫过期 key，防长期运行内存泄漏。
 * 用途：signup 按 IP/邮箱计所有尝试；login 只计失败、成功即清零。
 */

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;
  /** 清扫周期：超过此间隔做一次全量过期清理 */
  private readonly sweepEveryMs: number;

  constructor(sweepEveryMs = 600_000) {
    this.sweepEveryMs = sweepEveryMs;
  }

  private prune(key: string, windowMs: number, now: number): number[] {
    const arr = this.hits.get(key);
    if (!arr) return [];
    const cutoff = now - windowMs;
    // 时间戳单调递增，找到首个未过期位置一次性切片
    let i = 0;
    while (i < arr.length && arr[i]! <= cutoff) i++;
    const kept = i === 0 ? arr : arr.slice(i);
    if (kept.length === 0) this.hits.delete(key);
    else if (kept !== arr) this.hits.set(key, kept);
    return kept;
  }

  /** 全量清扫：删掉窗口内已无有效命中的 key（惰性触发） */
  private maybeSweep(windowMs: number, now: number): void {
    if (now - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = now;
    const cutoff = now - windowMs;
    for (const [key, arr] of this.hits) {
      if (arr.length === 0 || arr[arr.length - 1]! <= cutoff) this.hits.delete(key);
    }
  }

  /** 当前窗口内是否已达/超过上限（不记新命中） */
  tooMany(key: string, windowMs: number, max: number, now = Date.now()): boolean {
    this.maybeSweep(windowMs, now);
    return this.prune(key, windowMs, now).length >= max;
  }

  /** 记一次命中 */
  record(key: string, now = Date.now()): void {
    const arr = this.hits.get(key);
    if (arr) arr.push(now);
    else this.hits.set(key, [now]);
  }

  /** 清空某 key（login 成功后清零失败计数） */
  clear(key: string): void {
    this.hits.delete(key);
  }

  /** 测试辅助：全清 */
  reset(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }
}

/** header 值可能是 string | string[]，取首个非空字符串 */
function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v.find((x) => typeof x === 'string' && x.trim() !== '');
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 面板最小请求形状（fastify 天然兼容） */
export interface IpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * 取客户端真实 IP。🔴 面板在 cloudflared 隧道后，req.ip=回环，
 * 真实 IP 在 CF-Connecting-IP（优先）或 X-Forwarded-For 首段；都没有才回落 req.ip。
 * 否则所有人被当同一 IP，限速失效或误伤全体。
 */
export function clientIp(req: IpRequestLike): string {
  const cf = firstHeader(req.headers['cf-connecting-ip']);
  if (cf) return cf.trim();
  const xff = firstHeader(req.headers['x-forwarded-for']);
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return typeof req.ip === 'string' && req.ip !== '' ? req.ip : 'unknown';
}

/**
 * 邮箱归一化：trim + toLowerCase；gmail.com/googlemail.com 额外去点、去 +tag
 * 并统一到 gmail.com（user+1@ / u.s.e.r@ 别名收割防线）。
 * 其他域仅 trim+lowercase（点/大小写在多数域有语义，不擅自合并）。
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed; // 无本地部分/无域，原样
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}
