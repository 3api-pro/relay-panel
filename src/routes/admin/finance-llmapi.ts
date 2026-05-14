/**
 * 3api side endpoint: GET /admin/finance/llmapi-orders
 * Returns the calling reseller's own llmapi subscription orders by
 * calling llmapi's internal API with HMAC.
 *
 * Auth: reseller_admin (existing adminAuth middleware on /admin).
 * Uses reseller_admin.llmapi_user_id to know which user's orders to fetch.
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authAdmin } from '../../middleware/auth-admin';
import { query } from '../../services/database';
import { getConfig } from '../../services/app-config';
import { logger } from '../../services/logger';

export const adminFinanceLlmapiRouter = Router();
adminFinanceLlmapiRouter.use(authAdmin);

adminFinanceLlmapiRouter.get('/llmapi-orders', async (req: Request, res: Response): Promise<void> => {
  try {
    const adminId = (req as any).resellerAdmin?.id as number;
    // Fetch reseller_admin.llmapi_user_id
    const rows = await query<{ llmapi_user_id: number | null }>(
      `SELECT llmapi_user_id FROM reseller_admin WHERE id = $1`,
      [adminId],
    );
    if (rows.length === 0 || !rows[0].llmapi_user_id) {
      res.json({ ok: true, linked: false, orders: [] });
      return;
    }
    const llmapiUserId = rows[0].llmapi_user_id as number;

    const secret = getConfig('internal_topup_secret', '');
    const base = getConfig('llmapi_internal_base', 'http://172.31.240.1:3106');
    if (!secret) {
      res.status(503).json({ ok: false, error: 'cross-system secret not configured' });
      return;
    }

    const params = `limit=20&llmapi_user_id=${llmapiUserId}`;
    const sig = crypto.createHmac('sha256', secret).update(params, 'utf8').digest('hex');
    const url = `${base}/api/internal/user-orders?${params}&sig=${sig}`;

    const r = await fetch(url, { headers: { 'X-Llmapi-Signature': sig } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      res.json({ ok: false, linked: true, orders: [], err: `llmapi_${r.status}: ${txt.slice(0, 100)}` });
      return;
    }
    const d: any = await r.json();
    res.json({ ok: true, linked: true, orders: d.orders || [] });
  } catch (err: any) {
    logger.error({ err: err.message }, 'admin:finance:llmapi-orders:fail');
    res.status(500).json({ ok: false, error: err.message });
  }
});
