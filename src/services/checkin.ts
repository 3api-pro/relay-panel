/**
 * Daily check-in service (P1 #15).
 *
 * Storage: db/migrations/007-checkin.sql — `check_in_log` (one row per
 *           user per UTC day, enforced by unique index).
 * Config:  tenant.config JSONB, key 'checkin':
 *            { enabled, reward_tokens_per_day, streak_bonus_tokens,
 *              bonus_every_n_days }
 *          Defaults below if the key is missing.
 *
 * Reward delivery: the reward is added to the active subscription's
 *   `remaining_tokens` (the same column /v1/messages decrements). The
 *   user must therefore have an active subscription to redeem rewards;
 *   if they don't, doCheckIn returns the kind=no_subscription result
 *   and the caller surfaces a "please buy a plan first" message.
 *
 * Streak math:
 *   streak_days = 1 + COUNT(*) of check_in_log rows for this user where
 *     check_date is in the contiguous (UTC) range ending YESTERDAY.
 *   We compute it by scanning the last ~60 days and counting backwards
 *   until we find a gap. Cheap (60 rows) and accurate; no cron needed.
 *
 * Bonus:  every Nth contiguous day (default N=7) earns the bonus on top
 *         of the base reward.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from './database';
import { logger } from './logger';

export interface CheckinConfig {
  enabled: boolean;
  reward_tokens_per_day: number;
  streak_bonus_tokens: number;
  bonus_every_n_days: number;
}

const DEFAULTS: CheckinConfig = {
  enabled: true,
  reward_tokens_per_day: 50_000,    // 50k tokens / day. Tunable per-tenant.
  streak_bonus_tokens: 200_000,     // 200k bonus every 7 days.
  bonus_every_n_days: 7,
};

function coerceConfig(raw: any): CheckinConfig {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    enabled:               typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
    reward_tokens_per_day: Number.isFinite(o.reward_tokens_per_day) ? Number(o.reward_tokens_per_day) : DEFAULTS.reward_tokens_per_day,
    streak_bonus_tokens:   Number.isFinite(o.streak_bonus_tokens)   ? Number(o.streak_bonus_tokens)   : DEFAULTS.streak_bonus_tokens,
    bonus_every_n_days:    Number.isFinite(o.bonus_every_n_days) && Number(o.bonus_every_n_days) > 0
                            ? Number(o.bonus_every_n_days) : DEFAULTS.bonus_every_n_days,
  };
}

/**
 * Read the checkin config for a tenant (cached 30 s in-process). The
 * cache key is the tenant_id and the cached value also includes the
 * read-timestamp so admins flipping the toggle propagate inside one
 * minute without a redeploy.
 */
const cache = new Map<number, { v: CheckinConfig; expires: number }>();
const CACHE_TTL_MS = 30 * 1000;

export async function getCheckinConfig(tenantId: number): Promise<CheckinConfig> {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit && hit.expires > now) return hit.v;
  const rows = await query<{ config: any }>(
    `SELECT COALESCE(config, '{}'::jsonb) AS config FROM tenant WHERE id = $1 LIMIT 1`,
    [tenantId],
  );
  const v = coerceConfig(rows[0]?.config?.checkin);
  cache.set(tenantId, { v, expires: now + CACHE_TTL_MS });
  return v;
}

/**
 * Has this end_user already checked in for today (UTC)?
 */
export async function hasCheckedInToday(endUserId: number): Promise<boolean> {
  const r = await query<{ exists: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM check_in_log
         WHERE end_user_id = $1
           AND check_date = (NOW() AT TIME ZONE 'UTC')::date
     ) AS exists`,
    [endUserId],
  );
  return Boolean(r[0]?.exists);
}

/**
 * Compute the active streak — the number of contiguous UTC days
 * ending TODAY (or YESTERDAY if the user hasn't checked in yet) the
 * user has checked in. Returns 0 if no recent check-in exists.
 *
 * The number is "what the streak will be AFTER today's check-in"
 * when called from doCheckIn — caller offsets by 1 as appropriate.
 */
async function computeStreakBeforeToday(
  client: PoolClient,
  endUserId: number,
): Promise<number> {
  const r = await client.query<{ check_date: string }>(
    `SELECT check_date::text AS check_date
       FROM check_in_log
      WHERE end_user_id = $1
        AND check_date >= ((NOW() AT TIME ZONE 'UTC')::date - INTERVAL '60 days')::date
        AND check_date < (NOW() AT TIME ZONE 'UTC')::date
      ORDER BY check_date DESC`,
    [endUserId],
  );
  if (r.rows.length === 0) return 0;

  // Walk backwards from yesterday counting contiguous days.
  // First row must equal yesterday for the streak to be alive.
  const today = new Date();
  const yesterdayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

  let expected = isoDate(yesterdayUtc);
  let streak = 0;
  for (const row of r.rows) {
    if (row.check_date !== expected) break;
    streak++;
    const e = new Date(`${expected}T00:00:00Z`);
    e.setUTCDate(e.getUTCDate() - 1);
    expected = isoDate(e);
  }
  return streak;
}

export interface CheckinResult {
  kind: 'ok' | 'already_checked_in' | 'disabled' | 'no_subscription';
  reward_tokens: number;
  streak_days: number;
  is_bonus_day: boolean;
  // Subscription state after the credit.
  subscription_id?: number | null;
  remaining_tokens?: number | null;
}

/**
 * Atomically: check today's row doesn't exist, compute streak,
 * INSERT check_in_log row, credit subscription.remaining_tokens.
 *
 * Idempotent: a duplicate-insert (race) returns kind='already_checked_in'
 * without crediting.
 */
export async function doCheckIn(input: {
  tenantId: number;
  endUserId: number;
}): Promise<CheckinResult> {
  const conf = await getCheckinConfig(input.tenantId);
  if (!conf.enabled) {
    return { kind: 'disabled', reward_tokens: 0, streak_days: 0, is_bonus_day: false };
  }

  return withTransaction(async (client) => {
    // Find the user's currently active subscription (one tenant + user
    // can technically have many — we pick the soonest-expiring active
    // one so the reward goes somewhere useful).
    const sub = await client.query<{ id: number; remaining_tokens: string }>(
      `SELECT id, COALESCE(remaining_tokens, 0)::text AS remaining_tokens
         FROM subscription
        WHERE tenant_id = $1
          AND end_user_id = $2
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY expires_at ASC NULLS LAST, id DESC
        LIMIT 1
        FOR UPDATE`,
      [input.tenantId, input.endUserId],
    );

    if (sub.rows.length === 0) {
      // No subscription — politely reject. We don't INSERT the log row
      // because the user gained nothing and may want to retry after
      // purchasing.
      return {
        kind: 'no_subscription',
        reward_tokens: 0,
        streak_days: 0,
        is_bonus_day: false,
      };
    }

    const streakBefore = await computeStreakBeforeToday(client, input.endUserId);
    const newStreak = streakBefore + 1;
    const isBonusDay = newStreak > 0 && newStreak % conf.bonus_every_n_days === 0;
    const reward = conf.reward_tokens_per_day + (isBonusDay ? conf.streak_bonus_tokens : 0);

    // Insert the log row. Unique index enforces 1/day; race → no rows.
    const ins = await client.query<{ id: number }>(
      `INSERT INTO check_in_log
         (tenant_id, end_user_id, reward_tokens, streak_days)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (end_user_id, check_date) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.endUserId, reward, newStreak],
    );
    if (ins.rows.length === 0) {
      return {
        kind: 'already_checked_in',
        reward_tokens: 0,
        streak_days: streakBefore, // Existing streak unaltered.
        is_bonus_day: false,
        subscription_id: sub.rows[0].id,
        remaining_tokens: Number(sub.rows[0].remaining_tokens),
      };
    }

    // Credit the subscription. We add the reward_tokens unconditionally
    // — even if the user is near the plan cap. The plan cap is enforced
    // at sale time, not on rewards.
    const credited = await client.query<{ remaining_tokens: string }>(
      `UPDATE subscription
          SET remaining_tokens = COALESCE(remaining_tokens, 0) + $1
        WHERE id = $2
        RETURNING remaining_tokens`,
      [reward, sub.rows[0].id],
    );

    logger.info(
      {
        tenantId: input.tenantId,
        endUserId: input.endUserId,
        subscriptionId: sub.rows[0].id,
        reward,
        streak: newStreak,
        isBonusDay,
      },
      'checkin:granted',
    );

    return {
      kind: 'ok',
      reward_tokens: reward,
      streak_days: newStreak,
      is_bonus_day: isBonusDay,
      subscription_id: sub.rows[0].id,
      remaining_tokens: Number(credited.rows[0].remaining_tokens),
    };
  });
}

/**
 * Recent history — up to 30 days.
 */
export async function listRecentCheckins(endUserId: number): Promise<
  Array<{ check_date: string; reward_tokens: number; streak_days: number }>
> {
  const rows = await query<any>(
    `SELECT check_date::text AS check_date, reward_tokens, streak_days
       FROM check_in_log
      WHERE end_user_id = $1
        AND check_date >= ((NOW() AT TIME ZONE 'UTC')::date - INTERVAL '30 days')::date
      ORDER BY check_date DESC`,
    [endUserId],
  );
  return rows.map((r) => ({
    check_date: r.check_date,
    reward_tokens: Number(r.reward_tokens),
    streak_days: Number(r.streak_days),
  }));
}

/**
 * Public read of "what will I get if I check in today?". Used by the
 * status endpoint.
 */
export async function previewToday(
  tenantId: number,
  endUserId: number,
): Promise<{
  config: CheckinConfig;
  already_checked_in: boolean;
  current_streak: number;
  next_reward: number;
  next_is_bonus: boolean;
}> {
  const [conf, already] = await Promise.all([
    getCheckinConfig(tenantId),
    hasCheckedInToday(endUserId),
  ]);
  if (already) {
    // Streak _including_ today.
    const r = await query<{ streak_days: number }>(
      `SELECT streak_days FROM check_in_log
        WHERE end_user_id = $1
          AND check_date = (NOW() AT TIME ZONE 'UTC')::date
        LIMIT 1`,
      [endUserId],
    );
    return {
      config: conf,
      already_checked_in: true,
      current_streak: Number(r[0]?.streak_days ?? 0),
      next_reward: 0,
      next_is_bonus: false,
    };
  }
  // Compute what the streak WOULD be after today.
  const streakBefore = await withTransaction((client) => computeStreakBeforeToday(client, endUserId));
  const newStreak = streakBefore + 1;
  const isBonusDay = newStreak > 0 && newStreak % conf.bonus_every_n_days === 0;
  return {
    config: conf,
    already_checked_in: false,
    current_streak: streakBefore,
    next_reward: conf.reward_tokens_per_day + (isBonusDay ? conf.streak_bonus_tokens : 0),
    next_is_bonus: isBonusDay,
  };
}

/**
 * Test/admin helper: drop the cached config so a freshly-set
 * tenant.config.checkin propagates immediately.
 */
export function invalidateCheckinConfig(tenantId: number): void {
  cache.delete(tenantId);
}
