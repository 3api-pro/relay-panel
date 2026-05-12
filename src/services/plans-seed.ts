/**
 * Seed default plans + brand_config + wholesale_balance for a new tenant.
 *
 * Idempotent: ON CONFLICT (tenant_id, slug) DO NOTHING. Safe to call from
 * tenant-provisioning flows (platform.ts, signup-tenant.ts).
 *
 * Pricing aligned with llmapi direct-channel retail tiers — resellers earn
 * margin via batched wholesale, not by undercutting list. Token budgets are
 * guidance only; the wholesale_face_value is what the panel debits from the
 * reseller's upstream balance.
 */
import type { PoolClient } from 'pg';

interface PlanSeed {
  name: string;
  slug: string;
  period_days: number;
  quota_tokens: number;
  price_cents: number;
  wholesale_face_value_cents: number;
  sort_order: number;
  // v0.3 dual-billing. Default 'subscription' so existing call sites keep
  // working unchanged.
  billing_type?: 'subscription' | 'token_pack';
}

// 4 monthly subscriptions (v0.2 default lineup) + 2 token packs (v0.3).
// Token packs use period_days = 3650 (~10y) — semantically "permanent",
// drains via remaining_tokens countdown.
const DEFAULT_PLANS: PlanSeed[] = [
  // --- subscription (monthly recurring, period resets each order) ---------
  { name: 'Pro',     slug: 'pro',    period_days: 30,   quota_tokens:   5_000_000, price_cents:  2900, wholesale_face_value_cents:  2900, sort_order: 10, billing_type: 'subscription' },
  { name: 'Max 5x',  slug: 'max5x',  period_days: 30,   quota_tokens:  25_000_000, price_cents: 14900, wholesale_face_value_cents: 14900, sort_order: 20, billing_type: 'subscription' },
  { name: 'Max 20x', slug: 'max20x', period_days: 30,   quota_tokens: 100_000_000, price_cents: 29900, wholesale_face_value_cents: 29900, sort_order: 30, billing_type: 'subscription' },
  { name: 'Ultra',   slug: 'ultra',  period_days: 30,   quota_tokens: 300_000_000, price_cents: 59900, wholesale_face_value_cents: 59900, sort_order: 40, billing_type: 'subscription' },
  // --- token_pack (one-shot, no monthly cap; ~10y "permanent" expiry) ----
  { name: '10M Tokens 体验包', slug: 'pack-10m', period_days: 3650, quota_tokens:  10_000_000, price_cents: 1000, wholesale_face_value_cents: 1000, sort_order: 110, billing_type: 'token_pack' },
  { name: '50M Tokens 套餐',   slug: 'pack-50m', period_days: 3650, quota_tokens:  50_000_000, price_cents: 4500, wholesale_face_value_cents: 4500, sort_order: 120, billing_type: 'token_pack' },
];

const DEFAULT_ALLOWED_MODELS = ['claude-*', 'claude-sonnet-*', 'claude-opus-*', 'claude-haiku-*'];

export async function seedPlansForTenant(
  client: PoolClient,
  tenantId: number,
): Promise<number> {
  let inserted = 0;
  for (const p of DEFAULT_PLANS) {
    const r = await client.query<{ id: number }>(
      `INSERT INTO plans
         (tenant_id, name, slug, period_days, quota_tokens, price_cents,
          wholesale_face_value_cents, allowed_models, enabled, sort_order,
          billing_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, TRUE, $9, $10)
       ON CONFLICT (tenant_id, slug) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        p.name,
        p.slug,
        p.period_days,
        p.quota_tokens,
        p.price_cents,
        p.wholesale_face_value_cents,
        JSON.stringify(DEFAULT_ALLOWED_MODELS),
        p.sort_order,
        p.billing_type ?? 'subscription',
      ],
    );
    if (r.rows.length > 0) inserted++;
  }
  return inserted;
}

export async function seedBrandConfigForTenant(
  client: PoolClient,
  tenantId: number,
  storeName: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO brand_config (tenant_id, store_name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, storeName],
  );
}

export async function ensureWholesaleBalance(
  client: PoolClient,
  tenantId: number,
  initialCents = 0,
): Promise<void> {
  await client.query(
    `INSERT INTO wholesale_balance (tenant_id, balance_cents)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, initialCents],
  );
}
