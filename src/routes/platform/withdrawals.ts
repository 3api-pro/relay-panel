/**
 * Platform-side withdrawal admin endpoints. Authenticated via
 * X-Platform-Token header (matches PLATFORM_TOKEN env / /root/.3api-platform-token).
 *
 *   GET  /platform/withdrawals               — list queue (pending + approved)
 *   POST /platform/withdrawals/:id/approve   — approve (locks remain held)
 *   POST /platform/withdrawals/:id/reject    — reject + release lock
 *   POST /platform/withdrawals/:id/paid      — mark paid (debit ledger)
 */
import { Router, Request, Response, NextFunction } from 'express';
import {
  listPlatformQueue, approveWithdrawal, rejectWithdrawal, markWithdrawalPaid,
} from '../../services/withdrawal';
import { config } from '../../config';
import { logger } from '../../services/logger';

export const platformWithdrawalsRouter = Router();

function checkPlatformToken(req: Request, res: Response, next: NextFunction): void {
  const token = config.platformToken;
  if (!token) { res.status(503).json({ error: 'platform_token not configured' }); return; }
  const got = (req.headers['x-platform-token'] as string | undefined) || '';
  if (!got || got !== token) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}
platformWithdrawalsRouter.use(checkPlatformToken);

platformWithdrawalsRouter.get('/', async (_req: Request, res: Response) => {
  const queue = await listPlatformQueue(['pending', 'approved']);
  // mask card numbers
  const masked = queue.map((w: any) => ({
    ...w,
    card_number: w.card_number ? '****' + String(w.card_number).slice(-4) : null,
    confirm_code_hash: undefined,
  }));
  res.json({ withdrawals: masked });
});

platformWithdrawalsRouter.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { note, approved_by } = req.body ?? {};
    await approveWithdrawal({ withdrawalId: id, approvedBy: approved_by || 'platform', note });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

platformWithdrawalsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason, approved_by } = req.body ?? {};
    await rejectWithdrawal({ withdrawalId: id, approvedBy: approved_by || 'platform', reason: reason || 'platform reject' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

platformWithdrawalsRouter.post('/:id/paid', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { bank_txn_ref, approved_by } = req.body ?? {};
    await markWithdrawalPaid({ withdrawalId: id, approvedBy: approved_by || 'platform', bankTxnRef: bank_txn_ref });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
