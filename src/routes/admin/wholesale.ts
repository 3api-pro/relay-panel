/**
 * Admin wholesale-balance management.
 *
 * P0 ships a local-mirror table so the order engine can debit atomically
 * without round-tripping to llmapi-resell. Production will replace this
 * with a periodic sync cron. Until then, admin tops up manually after
 * paying upstream wholesale invoices.
 */
import { Router, Request, Response } from 'express';
import { query } from '../../services/database';
import { topupWholesale } from '../../services/order-engine';
import { logger } from '../../services/logger';

export const adminWholesaleRouter = Router();

/** GET /admin/wholesale */
adminWholesaleRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const rows = await query<{ balance_cents: string; updated_at: string }>(
    `SELECT balance_cents::text, updated_at::text
       FROM wholesale_balance WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) {
    res.json({ balance_cents: 0, updated_at: null });
    return;
  }
  res.json({
    balance_cents: Number(rows[0].balance_cents),
    updated_at: rows[0].updated_at,
  });
});

/** POST /admin/wholesale/topup  Body: { amount_cents } */
adminWholesaleRouter.post('/topup', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const amt = Number(req.body?.amount_cents);
  if (!Number.isFinite(amt) || amt === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'amount_cents required (can be negative for adjustments)' } });
    return;
  }
  const newBalance = await topupWholesale(tenantId, Math.trunc(amt));
  logger.info({ tenantId, adminId: req.resellerAdmin!.id, amount_cents: amt, newBalance }, 'admin:wholesale:topup');
  res.json({ balance_cents: newBalance });
});
