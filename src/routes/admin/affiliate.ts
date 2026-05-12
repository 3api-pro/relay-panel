/**
 * Admin affiliate routes (v0.4 P2 #18).
 *
 * Mounted under /admin so tenantResolver + authAdmin are inherited from
 * the parent. All endpoints read/write only the calling admin's own tenant
 * — the tenant id comes from req.resellerAdmin so a sub-domain trick
 * cannot reach another reseller's payouts.
 *
 *   GET   /admin/affiliate                — stats + aff_code + invite link
 *   GET   /admin/affiliate/referrals      — paginated referred tenants
 *   POST  /admin/affiliate/withdraw       — file payout request
 *   GET   /admin/affiliate/withdrawals    — list my payout requests
 */
import { Router, Request, Response } from 'express';
import {
  getAffiliateStats,
  listReferrals,
  listWithdrawals,
  requestWithdrawal,
} from '../../services/affiliate';
import { config } from '../../config';
import { logger } from '../../services/logger';

export const adminAffiliateRouter = Router();

function inviteLinkFor(affCode: string | null): string | null {
  if (!affCode) return null;
  const host = config.saasDomain || '3api.pro';
  return `https://${host}/create?ref=${encodeURIComponent(affCode)}`;
}

// =========================================================================
// GET /admin/affiliate
// =========================================================================
adminAffiliateRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  try {
    const stats = await getAffiliateStats(tenantId);
    res.json({
      ...stats,
      invite_link: inviteLinkFor(stats.aff_code),
      commission_pct_default: 10,
    });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:affiliate:get:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// GET /admin/affiliate/referrals?limit=50&offset=0
// =========================================================================
adminAffiliateRouter.get('/referrals', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
  try {
    const r = await listReferrals(tenantId, limit, offset);
    res.json({ data: r.data, total: r.total, limit, offset });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:affiliate:referrals:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

// =========================================================================
// POST /admin/affiliate/withdraw
//   body: { amount_cents: number, method: string, account_info: string }
// =========================================================================
adminAffiliateRouter.post('/withdraw', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body = req.body ?? {};
  const amount = Number(body.amount_cents);
  const method = typeof body.method === 'string' ? body.method : '';
  const accountInfo = typeof body.account_info === 'string' ? body.account_info : '';

  const r = await requestWithdrawal(tenantId, amount, method, accountInfo);
  if (!r.ok) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: r.reason || 'withdrawal_rejected' },
    });
    return;
  }
  res.status(201).json({ id: r.id, status: 'pending' });
});

// =========================================================================
// GET /admin/affiliate/withdrawals?limit=50&offset=0
// =========================================================================
adminAffiliateRouter.get('/withdrawals', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
  try {
    const rows = await listWithdrawals(tenantId, limit, offset);
    res.json({ data: rows, limit, offset });
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:affiliate:withdrawals:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
