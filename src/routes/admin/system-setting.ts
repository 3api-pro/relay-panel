/**
 * Admin system-setting routes (P1 #10).
 *
 * Mounted under /admin so tenantResolver + authAdmin are inherited from
 * the parent. Two endpoints:
 *
 *   GET   /admin/system-setting   — current per-tenant settings
 *   PATCH /admin/system-setting   — partial update; invalidates cache
 *
 * Only the resellerAdmin's own tenant can be read/written; the tenant id
 * is taken from req.resellerAdmin so subdomain trickery cannot reach
 * another tenant's settings.
 */
import { Router, Request, Response } from 'express';
import {
  getForTenant,
  patchForTenant,
  validatePatch,
} from '../../services/system-setting';
import { logger } from '../../services/logger';

export const adminSystemSettingRouter = Router();

adminSystemSettingRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  try {
    const v = await getForTenant(tenantId);
    res.json(v);
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:system-setting:get:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

adminSystemSettingRouter.patch('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body = req.body ?? {};
  const v = validatePatch(body);
  if (v) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: v } });
    return;
  }
  try {
    const out = await patchForTenant(tenantId, body);
    logger.info(
      {
        tenantId,
        adminId: req.resellerAdmin!.id,
        signup_enabled: out.signup_enabled,
        maintenance_mode: out.maintenance_mode,
      },
      'admin:system-setting:patch',
    );
    res.json(out);
  } catch (err: any) {
    logger.error({ err: err.message, tenantId }, 'admin:system-setting:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
