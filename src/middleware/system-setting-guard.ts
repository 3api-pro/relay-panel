/**
 * Middleware guards driven by per-tenant system_setting (P1 #10).
 *
 *   maintenanceGuard     — blocks the whole storefront when
 *                          system_setting.maintenance_mode = true.
 *                          /v1/messages has its own inline check in
 *                          routes/relay.ts (cheaper not to allocate a
 *                          middleware frame on every request).
 *   signupEnabledGuard   — blocks POST /storefront/auth/signup when
 *                          signup_enabled = false. Other auth routes
 *                          (login / reset / verify) remain open so
 *                          existing users can still recover access.
 *
 * Both guards rely on req.tenantId already being set by tenant-resolver
 * upstream of them. Failures to read the setting fall back to "open"
 * (see services/system-setting.ts).
 */
import type { Request, Response, NextFunction } from 'express';
import { getForTenant } from '../services/system-setting';

export async function maintenanceGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.tenantId) {
    next();
    return;
  }
  const s = await getForTenant(req.tenantId);
  if (s.maintenance_mode) {
    res.status(503).json({
      error: {
        type: 'maintenance',
        message: 'The service is under maintenance, please try again later.',
      },
    });
    return;
  }
  next();
}

export async function signupEnabledGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Only gate signup explicitly. Other /auth/* routes pass through.
  if (req.method !== 'POST' || !req.path.endsWith('/signup')) {
    next();
    return;
  }
  if (!req.tenantId) {
    next();
    return;
  }
  const s = await getForTenant(req.tenantId);
  if (!s.signup_enabled) {
    res.status(403).json({
      error: {
        type: 'signup_disabled',
        message: 'New signups are currently disabled for this storefront.',
      },
    });
    return;
  }
  next();
}
