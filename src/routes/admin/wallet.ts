/**
 * Reseller-side wallet endpoints. Authenticated as reseller_admin via existing
 * adminAuth middleware (Bearer or 3api_admin_token cookie).
 *
 *   GET    /admin/wallet/balance                 — wallet balance + locked
 *   GET    /admin/wallet/transactions            — last 50 ledger entries
 *   POST   /admin/wallet/topup-llmapi            — spend wallet to extend llmapi sub
 *   POST   /admin/wallet/withdraw                — submit withdrawal request
 *   POST   /admin/wallet/withdraw/:id/confirm    — confirm with email OTP
 *   POST   /admin/wallet/withdraw/:id/cancel     — cancel before approval
 *   GET    /admin/wallet/withdrawals             — list my withdrawal requests
 */
import { Router, Request, Response } from 'express';
import { authAdmin } from '../../middleware/auth-admin';
import { getWallet, listTransactions } from '../../services/wallet';
import {
  submitWithdrawal, confirmWithdrawal, cancelWithdrawal,
} from '../../services/withdrawal';
import { applyWalletToLlmapi } from '../../services/topup-llmapi';
import { query } from '../../services/database';
import { logger } from '../../services/logger';

export const adminWalletRouter = Router();
adminWalletRouter.use(authAdmin);

adminWalletRouter.get('/balance', async (req: Request, res: Response) => {
  const bal = await getWallet(req.tenantId!);
  res.json({
    balance_cents: bal.balance_cents,
    locked_cents: bal.locked_cents,
    spendable_cents: bal.balance_cents - bal.locked_cents,
    currency: bal.currency,
  });
});

adminWalletRouter.get('/transactions', async (req: Request, res: Response) => {
  const txs = await listTransactions(req.tenantId!, 50);
  res.json({ transactions: txs });
});

adminWalletRouter.post('/topup-llmapi', async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).resellerAdmin?.id as number;
    const { llmapi_user_id, amount_cents, plan_slug } = req.body ?? {};
    if (!llmapi_user_id || !amount_cents || !plan_slug) {
      res.status(400).json({ error: { type: 'invalid_request', message: 'missing fields' } });
      return;
    }
    if (typeof amount_cents !== 'number' || amount_cents <= 0 || amount_cents > 1_000_00) {
      // sanity cap 1000 元 single op; tweak as needed
      res.status(400).json({ error: { type: 'invalid_request', message: 'amount_cents out of range' } });
      return;
    }
    const result = await applyWalletToLlmapi(
      {
        tenantId: req.tenantId!, requestedBy: adminId,
        llmapiUserId: Number(llmapi_user_id), amountCents: amount_cents,
        planSlug: String(plan_slug),
      },
      req.ip,
    );
    res.json(result);
  } catch (err: any) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 402 : 500;
    res.status(status).json({ error: { type: err.code || 'internal', message: err.message } });
  }
});

adminWalletRouter.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).resellerAdmin?.id as number;
    const {
      gross_cents, currency,
      cardholder_name, bank_name, card_number,
      swift_code, iban, payout_country, contact_email,
    } = req.body ?? {};
    if (!gross_cents || !cardholder_name || !card_number || !contact_email) {
      res.status(400).json({ error: { type: 'invalid_request', message: '缺少必填字段 (gross_cents / cardholder_name / card_number / contact_email)' } });
      return;
    }
    if (typeof gross_cents !== 'number' || gross_cents < 1000) {
      res.status(400).json({ error: { type: 'invalid_request', message: '提现金额最低 10 元 (1000 cents)' } });
      return;
    }
    const out = await submitWithdrawal({
      tenantId: req.tenantId!, requestedBy: adminId,
      grossCents: gross_cents, currency: currency || 'CNY',
      cardholderName: cardholder_name, bankName: bank_name,
      cardNumber: card_number, swiftCode: swift_code,
      iban, payoutCountry: payout_country, contactEmail: contact_email,
    }, req.ip);
    res.json(out);
  } catch (err: any) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 402 :
                   err.code === 'BAD_AMOUNT' ? 400 : 500;
    res.status(status).json({ error: { type: err.code || 'internal', message: err.message } });
  }
});

adminWalletRouter.post('/withdraw/:id/confirm', async (req: Request, res: Response) => {
  try {
    const withdrawalId = parseInt(req.params.id, 10);
    const { otp } = req.body ?? {};
    if (!otp) { res.status(400).json({ error: { type: 'invalid_request', message: '缺少 otp' } }); return; }
    await confirmWithdrawal({ withdrawalId, tenantId: req.tenantId!, otp: String(otp) });
    res.json({ ok: true });
  } catch (err: any) {
    const status = err.code === 'NOT_FOUND' || err.code === 'OTP_EXPIRED' || err.code === 'OTP_MISMATCH' ? 400 : 500;
    res.status(status).json({ error: { type: err.code || 'internal', message: err.message } });
  }
});

adminWalletRouter.post('/withdraw/:id/cancel', async (req: Request, res: Response) => {
  try {
    const withdrawalId = parseInt(req.params.id, 10);
    await cancelWithdrawal({ withdrawalId, tenantId: req.tenantId! });
    res.json({ ok: true });
  } catch (err: any) {
    const status = err.code === 'BAD_STATE' ? 400 : 500;
    res.status(status).json({ error: { type: err.code || 'internal', message: err.message } });
  }
});

adminWalletRouter.get('/withdrawals', async (req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, gross_cents, fee_cents, net_cents, currency, status,
            cardholder_name, RIGHT(card_number, 4) AS card_last4,
            bank_name, payout_country, created_at, approved_at, paid_at, platform_note
       FROM withdrawal_request
      WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT 50`,
    [req.tenantId!],
  );
  res.json({ withdrawals: rows });
});
