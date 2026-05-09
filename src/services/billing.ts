/**
 * Quota-cents based billing.
 * Default pricing (per-tenant overridable via tenant.config later):
 *   input  cost: 100 cents per 1M tokens  (¥1/M)
 *   output cost: 500 cents per 1M tokens  (¥5/M)
 * Reseller sets retail price; end-user pays from quota_cents.
 */
import { withTransaction } from './database';
import { logger } from './logger';

const DEFAULT_INPUT_PRICE_CPM = 100;   // cents per million
const DEFAULT_OUTPUT_PRICE_CPM = 500;

export interface BillingInput {
  tenantId: number;
  endUserId: number;
  endTokenId: number;
  channelId?: number | null;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  requestId?: string | null;
  elapsedMs: number;
  isStream: boolean;
  status: 'success' | 'failure';
}

export async function recordUsageAndBill(input: BillingInput): Promise<{
  chargedCents: number;
  remainCents: number;
}> {
  const chargedCents =
    Math.ceil(
      (input.promptTokens * DEFAULT_INPUT_PRICE_CPM +
        input.completionTokens * DEFAULT_OUTPUT_PRICE_CPM) /
        1_000_000,
    );

  return withTransaction(async (client) => {
    if (chargedCents > 0 && input.status === 'success') {
      await client.query(
        `UPDATE end_user
            SET used_quota_cents = used_quota_cents + $1
          WHERE id = $2 AND tenant_id = $3`,
        [chargedCents, input.endUserId, input.tenantId],
      );

      await client.query(
        `UPDATE end_token
            SET used_quota_cents = used_quota_cents + $1,
                remain_quota_cents = GREATEST(0, remain_quota_cents - $1),
                last_used_at = NOW()
          WHERE id = $2`,
        [chargedCents, input.endTokenId],
      );
    }

    await client.query(
      `INSERT INTO usage_log
         (tenant_id, end_user_id, end_token_id, channel_id, model_name,
          prompt_tokens, completion_tokens, quota_charged_cents,
          request_id, elapsed_ms, is_stream, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.tenantId,
        input.endUserId,
        input.endTokenId,
        input.channelId ?? null,
        input.modelName,
        input.promptTokens,
        input.completionTokens,
        chargedCents,
        input.requestId ?? null,
        input.elapsedMs,
        input.isStream,
        input.status,
      ],
    );

    const { rows } = await client.query<{ remain: string }>(
      `SELECT remain_quota_cents AS remain FROM end_token WHERE id = $1`,
      [input.endTokenId],
    );
    const remainCents = Number(rows[0]?.remain ?? 0);

    logger.info(
      {
        tenantId: input.tenantId,
        endTokenId: input.endTokenId,
        chargedCents,
        remainCents,
        model: input.modelName,
      },
      'billing:charged',
    );

    return { chargedCents, remainCents };
  });
}
