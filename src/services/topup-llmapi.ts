/**
 * Cross-system topup: spend reseller's 3api wallet balance to extend their
 * llmapi subscription (no platform fee, internal transfer).
 *
 * Trust: HMAC-SHA256, shared secret in 3api.app_config.internal_topup_secret
 * and llmapi.app_config.internal_topup_secret (same value).
 *
 * Idempotency: caller passes idempotency_key; llmapi side records and rejects
 * second call with the same key.
 *
 * Flow:
 *   1. 3api side: createTopupRequest() — locks DB row 'pending', validates
 *      balance >= amount
 *   2. 3api side: callLlmapiTopup() — signs HMAC, POSTs llmapi
 *   3. llmapi extends user.sub by mapped days/tokens, returns success
 *   4. 3api side: debit wallet (topup_llmapi), mark 'succeeded'
 *
 * Failure modes:
 *   - llmapi 5xx / timeout: wallet NOT debited, request 'failed', user can retry
 *   - llmapi returns rejected (e.g. plan not found): wallet NOT debited
 *   - duplicate idempotency: llmapi returns the prior result, 3api still
 *     records 'succeeded' (already debited last time — guard via wallet idem)
 */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';
import { query, withTransaction } from './database';
import { getConfig } from './app-config';
import { logger } from './logger';
import { debitTopupLlmapi, getWallet } from './wallet';

let _disp: ProxyAgent | undefined;
let _dispUrl: string | undefined;
function dispatcher(): any {
  const proxy = getConfig('outbound_https_proxy', '');
  if (proxy && proxy !== _dispUrl) { _disp = new ProxyAgent(proxy); _dispUrl = proxy; }
  else if (!proxy) { _disp = undefined; _dispUrl = undefined; }
  return _disp;
}

export interface TopupRequestInput {
  tenantId: number;
  requestedBy: number;
  llmapiUserId: number;
  amountCents: number;
  planSlug: string;
}

export async function applyWalletToLlmapi(inp: TopupRequestInput, ip?: string | null): Promise<{ id: number; status: 'succeeded' | 'failed'; err?: string }> {
  // Pre-check balance (locked excluded).
  const wallet = await getWallet(inp.tenantId);
  const spendable = wallet.balance_cents - wallet.locked_cents;
  if (spendable < inp.amountCents) {
    throw Object.assign(new Error('insufficient_balance'), { code: 'INSUFFICIENT_BALANCE' });
  }

  // Insert a pending request, get the id (idempotency_key derived from inputs).
  const idemKey = `topup:${inp.tenantId}:${inp.llmapiUserId}:${inp.planSlug}:${Date.now()}`;
  const requestId = await withTransaction(async (client) => {
    const r = await client.query<{ id: number }>(
      `INSERT INTO llmapi_topup_request
         (tenant_id, requested_by, llmapi_user_id, amount_cents, plan_slug, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       RETURNING id`,
      [inp.tenantId, inp.requestedBy, inp.llmapiUserId, inp.amountCents, inp.planSlug, idemKey],
    );
    return r.rows[0].id;
  });

  // Sign + call llmapi.
  const secret = getConfig('internal_topup_secret', '');
  const llmapiBase = getConfig('llmapi_internal_base', 'https://api.llmapi.pro');
  if (!secret) {
    await query(`UPDATE llmapi_topup_request SET status='failed', err_short=$2 WHERE id=$1`, [requestId, 'no_secret']);
    return { id: requestId, status: 'failed', err: 'internal_topup_secret_missing' };
  }

  const payload = JSON.stringify({
    request_id: requestId,
    llmapi_user_id: inp.llmapiUserId,
    amount_cents: inp.amountCents,
    plan_slug: inp.planSlug,
    idempotency_key: idemKey,
    tenant_id: inp.tenantId,
    timestamp: Date.now(),
  });
  const sig = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  try {
    const r = await fetch(`${llmapiBase}/api/internal/topup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-3api-Signature': sig,
      },
      body: payload,
      dispatcher: dispatcher(),
    } as any);
    const text = await r.text();
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch {}
    if (!r.ok || parsed.success === false) {
      const err = `llmapi_${r.status}:${(parsed.error || text).toString().slice(0, 100)}`;
      await query(`UPDATE llmapi_topup_request SET status='failed', err_short=$2 WHERE id=$1`, [requestId, err]);
      return { id: requestId, status: 'failed', err };
    }

    // Debit wallet (idempotent via topup_llmapi:<requestId> key)
    await debitTopupLlmapi({
      tenantId: inp.tenantId,
      amountCents: inp.amountCents,
      topupId: requestId,
      ip: ip ?? null,
    });
    await query(
      `UPDATE llmapi_topup_request SET status='succeeded', succeeded_at=now(), llmapi_order_id=$2 WHERE id=$1`,
      [requestId, parsed.llmapi_order_id ?? null],
    );
    logger.info({ requestId, tenantId: inp.tenantId, llmapi_user_id: inp.llmapiUserId, plan: inp.planSlug, amount: inp.amountCents }, 'topup_llmapi:succeeded');
    return { id: requestId, status: 'succeeded' };
  } catch (err: any) {
    const errMsg = (err.message || String(err)).slice(0, 200);
    await query(`UPDATE llmapi_topup_request SET status='failed', err_short=$2 WHERE id=$1`, [requestId, errMsg]);
    logger.error({ err: errMsg, requestId }, 'topup_llmapi:exception');
    return { id: requestId, status: 'failed', err: errMsg };
  }
}
