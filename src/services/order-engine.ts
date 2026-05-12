/**
 * Order engine — token-based subscription billing.
 *
 * Flow:
 *   1. createOrder(...)     → row in 'orders' status=pending, expires in 30min.
 *      The end user is now in the payment provider's hands.
 *   2. confirmPaid(...)     → transactional:
 *      a. lock + mark order paid (idempotent on idempotency_key + status check)
 *      b. debit wholesale_balance atomically (CTE; 0-rows = balance shortage)
 *      c. insert subscription with remaining_tokens = plan.quota_tokens
 *      d. issue sk- api token bound to the subscription
 *      → returns { order, subscription, api_token, raw_key }
 *      Insufficient wholesale balance flips order.status to
 *      'paid_pending_provision' so the operator can top up + complete.
 *   3. recordUsage(...)     → atomic decrement on subscription.remaining_tokens
 *      (using GREATEST so we never underflow); writes usage_log row.
 *
 * Wholesale balance is mirrored from the upstream API. Real-time sync is a
 * separate cron. For now we trust the local mirror.
 *
 * Concurrency: every state transition runs inside a single transaction with
 * row locks (FOR UPDATE / conditional UPDATE) so concurrent
 * Paddle/Alipay/USDT webhooks for the same order don't double-issue tokens.
 */
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { withTransaction, query } from './database';
import { logger } from './logger';

export interface CreateOrderInput {
  tenantId: number;
  endUserId: number;
  planId: number;
  couponCode?: string | null;
  paymentProvider?: string | null;
  idempotencyKey?: string;
}

export interface CreatedOrder {
  id: number;
  tenant_id: number;
  end_user_id: number;
  plan_id: number;
  amount_cents: number;
  currency: string;
  status: string;
  idempotency_key: string;
  expires_at: string;
  created_at: string;
}

export interface ConfirmPaidResult {
  order: any;
  subscription: any;
  api_token: any;
  raw_key: string;
  wholesale_shortage: boolean;
}

const ORDER_EXPIRES_MINUTES = 30;

function generateIdempotencyKey(): string {
  // RFC 4122 v4-ish — fine for unique-constraint dedup
  const b = crypto.randomBytes(16);
  // eslint-disable-next-line no-bitwise
  b[6] = (b[6] & 0x0f) | 0x40;
  // eslint-disable-next-line no-bitwise
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function generateSkKey(): string {
  return `sk-relay-${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Apply a coupon to a plan price. Returns the discounted amount in cents.
 * If both discount_pct and discount_cents are set, discount_cents wins.
 */
async function applyCoupon(
  client: PoolClient,
  tenantId: number,
  basePriceCents: number,
  couponCode: string | null | undefined,
): Promise<{ amount_cents: number; coupon_id: number | null }> {
  if (!couponCode) return { amount_cents: basePriceCents, coupon_id: null };

  const r = await client.query<any>(
    `SELECT id, discount_pct, discount_cents, max_uses, used_count, expires_at, enabled
       FROM coupon
      WHERE tenant_id = $1 AND code = $2
      FOR UPDATE`,
    [tenantId, couponCode],
  );
  if (r.rows.length === 0) return { amount_cents: basePriceCents, coupon_id: null };
  const c = r.rows[0];
  if (!c.enabled) return { amount_cents: basePriceCents, coupon_id: null };
  if (c.expires_at && new Date(c.expires_at) < new Date()) {
    return { amount_cents: basePriceCents, coupon_id: null };
  }
  if (c.max_uses != null && Number(c.used_count) >= Number(c.max_uses)) {
    return { amount_cents: basePriceCents, coupon_id: null };
  }

  let amount = basePriceCents;
  if (c.discount_cents != null) {
    amount = Math.max(0, basePriceCents - Number(c.discount_cents));
  } else if (c.discount_pct != null) {
    const pct = Math.max(0, Math.min(100, Number(c.discount_pct)));
    amount = Math.max(0, Math.floor((basePriceCents * (100 - pct)) / 100));
  }
  return { amount_cents: amount, coupon_id: c.id };
}

export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();

  return withTransaction(async (client) => {
    // Dedup: if a non-expired pending/paid order with this idempotency key exists, return it.
    const existing = await client.query<CreatedOrder>(
      `SELECT id, tenant_id, end_user_id, plan_id, amount_cents, currency, status,
              idempotency_key, expires_at::text AS expires_at, created_at::text AS created_at
         FROM orders
        WHERE idempotency_key = $1
        LIMIT 1`,
      [idempotencyKey],
    );
    if (existing.rows.length > 0) {
      logger.info({ orderId: existing.rows[0].id, idempotencyKey }, 'order:created:idempotent_hit');
      return existing.rows[0];
    }

    // Plan + tenant check
    const planRows = await client.query<any>(
      `SELECT id, tenant_id, price_cents, enabled
         FROM plans
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [input.planId, input.tenantId],
    );
    if (planRows.rows.length === 0) {
      throw Object.assign(new Error('plan_not_found'), { code: 'PLAN_NOT_FOUND' });
    }
    if (!planRows.rows[0].enabled) {
      throw Object.assign(new Error('plan_disabled'), { code: 'PLAN_DISABLED' });
    }

    const basePrice = Number(planRows.rows[0].price_cents);
    const { amount_cents, coupon_id } = await applyCoupon(
      client,
      input.tenantId,
      basePrice,
      input.couponCode,
    );

    const r = await client.query<CreatedOrder>(
      `INSERT INTO orders
         (tenant_id, end_user_id, plan_id, amount_cents, currency,
          payment_provider, status, idempotency_key, coupon_id, expires_at)
       VALUES ($1, $2, $3, $4, 'CNY', $5, 'pending', $6, $7,
               NOW() + ($8::int || ' minutes')::interval)
       RETURNING id, tenant_id, end_user_id, plan_id, amount_cents, currency, status,
                 idempotency_key, expires_at::text AS expires_at, created_at::text AS created_at`,
      [
        input.tenantId,
        input.endUserId,
        input.planId,
        amount_cents,
        input.paymentProvider ?? null,
        idempotencyKey,
        coupon_id,
        ORDER_EXPIRES_MINUTES,
      ],
    );

    logger.info(
      {
        orderId: r.rows[0].id,
        tenantId: input.tenantId,
        endUserId: input.endUserId,
        planId: input.planId,
        amount: amount_cents,
        couponId: coupon_id,
      },
      'order:created',
    );

    return r.rows[0];
  });
}

export async function confirmPaid(
  orderId: number,
  providerTxnId: string | null,
): Promise<ConfirmPaidResult> {
  return withTransaction(async (client) => {
    // 1. Mark order paid (atomic on status='pending')
    const orderRow = await client.query<any>(
      `UPDATE orders
          SET status = 'paid', paid_at = NOW(), provider_txn_id = $1
        WHERE id = $2 AND status = 'pending'
        RETURNING *`,
      [providerTxnId, orderId],
    );

    if (orderRow.rows.length === 0) {
      // Either already-paid (idempotent return) or non-existent
      const cur = await client.query<any>(
        `SELECT * FROM orders WHERE id = $1 LIMIT 1`,
        [orderId],
      );
      if (cur.rows.length === 0) {
        throw Object.assign(new Error('order_not_found'), { code: 'ORDER_NOT_FOUND' });
      }
      const o = cur.rows[0];
      if (o.status === 'paid' || o.status === 'paid_pending_provision') {
        // Find the provisioned subscription + token (if any) for idempotent reply
        const sub = await client.query<any>(
          `SELECT * FROM subscription WHERE order_id = $1 LIMIT 1`,
          [orderId],
        );
        const tok = sub.rows[0]
          ? await client.query<any>(
              `SELECT id, key_prefix, name, status, subscription_id
                 FROM end_token WHERE subscription_id = $1 LIMIT 1`,
              [sub.rows[0].id],
            )
          : { rows: [] };
        return {
          order: o,
          subscription: sub.rows[0] ?? null,
          api_token: tok.rows[0] ?? null,
          raw_key: '',
          wholesale_shortage: o.status === 'paid_pending_provision',
        };
      }
      throw Object.assign(new Error(`order_status_${o.status}`), { code: 'ORDER_STATUS_INVALID' });
    }

    const order = orderRow.rows[0];

    // 2. Load plan (we need quota_tokens / wholesale_face_value)
    const planRow = await client.query<any>(
      `SELECT id, name, period_days, quota_tokens, wholesale_face_value_cents,
              allowed_models, billing_type
         FROM plans WHERE id = $1 LIMIT 1`,
      [order.plan_id],
    );
    const plan = planRow.rows[0];
    // v0.3 dual-billing: token_pack overrides period_days regardless of what
    // the row says (defensive — admin UI should already force it, but a
    // direct SQL row edit shouldn't break the invariant).
    const isTokenPack = plan.billing_type === 'token_pack';
    const effectivePeriodDays = isTokenPack ? 3650 : plan.period_days;

    // 3. Debit wholesale_balance atomically (CTE upsert if missing first)
    await client.query(
      `INSERT INTO wholesale_balance (tenant_id, balance_cents)
       VALUES ($1, 0) ON CONFLICT (tenant_id) DO NOTHING`,
      [order.tenant_id],
    );

    const debit = await client.query<{ balance_cents: string }>(
      `UPDATE wholesale_balance
          SET balance_cents = balance_cents - $1,
              updated_at = NOW()
        WHERE tenant_id = $2
          AND balance_cents >= $1
        RETURNING balance_cents`,
      [plan.wholesale_face_value_cents, order.tenant_id],
    );

    let wholesale_shortage = false;
    if (debit.rows.length === 0) {
      // Balance shortage — flip status and bail out before provisioning.
      await client.query(
        `UPDATE orders SET status = 'paid_pending_provision' WHERE id = $1`,
        [orderId],
      );
      wholesale_shortage = true;
      logger.warn(
        {
          orderId,
          tenantId: order.tenant_id,
          required: plan.wholesale_face_value_cents,
        },
        'order:wholesale_shortage',
      );
      const refreshed = await client.query<any>(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      return {
        order: refreshed.rows[0],
        subscription: null,
        api_token: null,
        raw_key: '',
        wholesale_shortage,
      };
    }

    // 4. Create subscription. Both billing types use the same row layout;
    //    /v1/messages debit logic sums all active subs and burns oldest-
    //    expires-first, so subscriptions naturally drain before token packs.
    //    is_primary=TRUE for subscription rows, FALSE for token_pack rows —
    //    purely informational (the "main" plan shown in dashboard header).
    const subRow = await client.query<any>(
      `INSERT INTO subscription
         (tenant_id, end_user_id, plan_name, plan_id, order_id, status,
          period_start, period_end, expires_at, remaining_tokens, is_primary)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW(),
               NOW() + ($6::int || ' days')::interval,
               NOW() + ($6::int || ' days')::interval,
               $7, $8)
       RETURNING *`,
      [
        order.tenant_id,
        order.end_user_id,
        plan.name,
        plan.id,
        order.id,
        effectivePeriodDays,
        plan.quota_tokens,
        !isTokenPack, // subscriptions are primary, token packs are addons
      ],
    );
    const subscription = subRow.rows[0];

    // 5. Mint sk- API token
    const rawKey = generateSkKey();
    const keyPrefix = rawKey.substring(0, 16);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const tokRow = await client.query<any>(
      `INSERT INTO end_token
         (tenant_id, end_user_id, subscription_id, name, key_prefix, key_hash,
          remain_quota_cents, unlimited_quota, allowed_models, status,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE, $7, 'active', $8)
       RETURNING id, name, key_prefix, status, subscription_id, expires_at, created_at`,
      [
        order.tenant_id,
        order.end_user_id,
        subscription.id,
        `Plan: ${plan.name}`,
        keyPrefix,
        keyHash,
        plan.allowed_models ? JSON.stringify(plan.allowed_models) : null,
        subscription.expires_at,
      ],
    );

    // 6. Bump coupon usage if used
    if (order.coupon_id) {
      await client.query(
        `UPDATE coupon SET used_count = used_count + 1 WHERE id = $1`,
        [order.coupon_id],
      );
    }

    logger.info(
      {
        orderId: order.id,
        subscriptionId: subscription.id,
        endTokenId: tokRow.rows[0].id,
        tenantId: order.tenant_id,
        endUserId: order.end_user_id,
        planId: plan.id,
        amount: order.amount_cents,
      },
      'order:paid_and_provisioned',
    );

    return {
      order,
      subscription,
      api_token: tokRow.rows[0],
      raw_key: rawKey,
      wholesale_shortage,
    };
  });
}

/**
 * Charge tokens against a user's active subscriptions — FIFO debit across
 * all active rows (oldest expires_at first). Atomic — never goes negative.
 *
 * v0.3 dual-billing: a single end_user can hold a monthly subscription AND
 * one or more token packs in parallel. Subscriptions naturally expire
 * sooner (30d vs 3650d for packs), so oldest-expires-first burns the
 * subscription's allowance first then drains pack(s). All within one
 * transaction with FOR UPDATE so concurrent /v1/messages don't double-bill.
 *
 * input.subscriptionId is the sub the token was originally minted against
 * — used purely for the usage_log row (audit). The debit itself looks at
 * the whole active set for input.endUserId. If the originating sub is the
 * only one left active and dry, debit fails and the caller 402s.
 *
 * Returns the post-charge remaining_tokens for the originating sub (for
 * the legacy single-sub response shape) and total across all subs.
 */
export async function recordUsage(input: {
  tenantId: number;
  endUserId: number;
  endTokenId: number;
  subscriptionId: number | null;
  channelId?: number | null;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  costCents?: number;
  requestId?: string | null;
  elapsedMs: number;
  isStream: boolean;
  status: 'success' | 'failure';
}): Promise<{ remaining_tokens: number | null; charged_tokens: number; total_remaining_tokens?: number }> {
  const chargedTokens = Math.max(0, input.promptTokens + input.completionTokens);

  return withTransaction(async (client) => {
    let originRemaining: number | null = null;
    let totalRemaining = 0;

    if (chargedTokens > 0 && input.status === 'success') {
      // Lock all active subs for this end_user (FOR UPDATE so concurrent
      // billing on the same user serializes). Order: oldest expires first,
      // then id ASC for tie-breaking. Subscriptions (30d expiry) drain
      // before token_packs (3650d expiry) naturally.
      const subs = await client.query<{ id: number; remaining_tokens: string }>(
        `SELECT id, remaining_tokens
           FROM subscription
          WHERE tenant_id = $1
            AND end_user_id = $2
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > NOW())
            AND remaining_tokens > 0
          ORDER BY expires_at ASC NULLS LAST, id ASC
          FOR UPDATE`,
        [input.tenantId, input.endUserId],
      );

      let need = chargedTokens;
      for (const s of subs.rows) {
        if (need <= 0) break;
        const have = Number(s.remaining_tokens);
        const take = Math.min(need, have);
        const r = await client.query<{ remaining_tokens: string }>(
          `UPDATE subscription
              SET remaining_tokens = GREATEST(0, remaining_tokens - $1)
            WHERE id = $2 AND status = 'active'
            RETURNING remaining_tokens`,
          [take, s.id],
        );
        if (r.rows.length > 0) {
          need -= take;
          if (s.id === input.subscriptionId) {
            originRemaining = Number(r.rows[0].remaining_tokens);
          }
        }
      }

      // If the origin sub wasn't in the active set (e.g. expired since
      // auth-token check), report its row's current state for the response.
      if (originRemaining == null && input.subscriptionId != null) {
        const cur = await client.query<{ remaining_tokens: string }>(
          `SELECT remaining_tokens FROM subscription WHERE id = $1`,
          [input.subscriptionId],
        );
        if (cur.rows.length > 0) originRemaining = Number(cur.rows[0].remaining_tokens);
      }
    } else if (input.subscriptionId != null) {
      // Status=failure or 0 tokens — still surface origin sub's remaining.
      const cur = await client.query<{ remaining_tokens: string }>(
        `SELECT remaining_tokens FROM subscription WHERE id = $1`,
        [input.subscriptionId],
      );
      if (cur.rows.length > 0) originRemaining = Number(cur.rows[0].remaining_tokens);
    }

    // Total remaining across active subs (post-debit) — surfaces in API
    // response & dashboard so the user can see token_pack reserves.
    const tot = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(remaining_tokens), 0)::text AS total
         FROM subscription
        WHERE tenant_id = $1 AND end_user_id = $2 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [input.tenantId, input.endUserId],
    );
    totalRemaining = Number(tot.rows[0]?.total ?? 0);

    await client.query(
      `INSERT INTO usage_log
         (tenant_id, end_user_id, end_token_id, channel_id, subscription_id,
          model_name, prompt_tokens, completion_tokens, quota_charged_cents,
          request_id, elapsed_ms, is_stream, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.tenantId,
        input.endUserId,
        input.endTokenId,
        input.channelId ?? null,
        input.subscriptionId,
        input.modelName,
        input.promptTokens,
        input.completionTokens,
        input.costCents ?? 0,
        input.requestId ?? null,
        input.elapsedMs,
        input.isStream,
        input.status,
      ],
    );

    return {
      remaining_tokens: originRemaining,
      charged_tokens: chargedTokens,
      total_remaining_tokens: totalRemaining,
    };
  });
}

/**
 * Read total active tokens across a user's subscriptions split by billing
 * type. Backs /storefront/balance and end_user dashboard panel.
 */
export async function getEndUserTokenBalance(
  tenantId: number,
  endUserId: number,
): Promise<{ subscription_tokens: number; token_pack_tokens: number; total: number }> {
  const rows = await query<{ billing_type: string | null; sum: string }>(
    `SELECT COALESCE(p.billing_type, 'subscription') AS billing_type,
            COALESCE(SUM(s.remaining_tokens), 0)::text AS sum
       FROM subscription s
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1
        AND s.end_user_id = $2
        AND s.status = 'active'
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
      GROUP BY COALESCE(p.billing_type, 'subscription')`,
    [tenantId, endUserId],
  );
  let sub = 0;
  let pack = 0;
  for (const r of rows) {
    const v = Number(r.sum);
    if (r.billing_type === 'token_pack') pack += v;
    else sub += v;
  }
  return { subscription_tokens: sub, token_pack_tokens: pack, total: sub + pack };
}

/**
 * Top up a tenant's wholesale balance — called by admin tooling once real
 * wholesale account integration lands. For now a manual lever.
 */
export async function topupWholesale(tenantId: number, cents: number): Promise<number> {
  const r = await query<{ balance_cents: string }>(
    `INSERT INTO wholesale_balance (tenant_id, balance_cents)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET balance_cents = wholesale_balance.balance_cents + EXCLUDED.balance_cents,
           updated_at = NOW()
     RETURNING balance_cents`,
    [tenantId, cents],
  );
  return Number(r[0]?.balance_cents ?? 0);
}
