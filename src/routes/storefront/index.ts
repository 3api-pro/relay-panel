/**
 * Storefront router — public-facing customer store.
 *
 * Mount: app.use('/storefront', tenantResolver, storefrontRouter)
 *
 * Sub-paths:
 *   /auth/*        — signup / login / verify / forgot / reset (public)
 *   /plans         — public plan catalog
 *   /brand         — public brand config
 *   /orders        — authed: create + list own orders
 *   /subscriptions — authed: list own subscriptions
 *
 * tenantResolver runs once at the mount point. Customer auth is applied
 * per-route via authCustomer to keep the public catalog reachable.
 */
import { Router } from 'express';
import { storefrontAuthRouter } from './auth';
import { storefrontPlansRouter } from './plans';
import { storefrontCheckinRouter } from './checkin';
import { maintenanceGuard, signupEnabledGuard } from '../../middleware/system-setting-guard';

export const storefrontRouter = Router();

// Maintenance gate — when system_setting.maintenance_mode = true for the
// resolved tenant, ALL storefront routes return 503. /auth/signup also
// honours signup_enabled (signupEnabledGuard applied inside storefrontAuthRouter).
storefrontRouter.use(maintenanceGuard);

storefrontRouter.use('/auth', signupEnabledGuard, storefrontAuthRouter);
// /plans and /brand are public; /orders + /subscriptions inline authCustomer.
storefrontRouter.use('/', storefrontPlansRouter);
// /checkin{,/status,/history} — all routes require authCustomer.
storefrontRouter.use('/', storefrontCheckinRouter);
