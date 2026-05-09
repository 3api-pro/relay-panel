/**
 * Tiny in-memory IP rate limiter. Single-process only — when the panel
 * scales to multiple replicas, swap for a Postgres / Redis backend.
 *
 * Usage:
 *   const limiter = new RateLimiter([{ windowMs: 60_000, max: 1 }, { windowMs: 3_600_000, max: 10 }]);
 *   const verdict = limiter.check(req.ip);
 *   if (!verdict.allowed) return res.status(429).json({ ... });
 */

interface Bucket {
  windowMs: number;
  max: number;
  hits: Map<string, { count: number; resetAt: number }>;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSec?: number;
  bucket?: { windowMs: number; max: number };
}

export class RateLimiter {
  private buckets: Bucket[];
  constructor(configs: RateLimitConfig[]) {
    this.buckets = configs.map((c) => ({ ...c, hits: new Map() }));
  }

  check(key: string): RateLimitVerdict {
    const now = Date.now();
    for (const b of this.buckets) {
      const slot = b.hits.get(key);
      if (slot && slot.resetAt > now) {
        if (slot.count >= b.max) {
          return {
            allowed: false,
            retryAfterSec: Math.ceil((slot.resetAt - now) / 1000),
            bucket: { windowMs: b.windowMs, max: b.max },
          };
        }
      }
    }
    // All buckets allow — record one hit on each.
    for (const b of this.buckets) {
      const slot = b.hits.get(key);
      if (!slot || slot.resetAt <= now) {
        b.hits.set(key, { count: 1, resetAt: now + b.windowMs });
      } else {
        slot.count += 1;
      }
    }
    return { allowed: true };
  }

  /**
   * Periodic cleanup — call from setInterval if running long.
   */
  sweep(): void {
    const now = Date.now();
    for (const b of this.buckets) {
      for (const [k, v] of b.hits) {
        if (v.resetAt <= now) b.hits.delete(k);
      }
    }
  }
}
