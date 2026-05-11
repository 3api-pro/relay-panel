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

export const storefrontRouter = Router();

storefrontRouter.use('/auth', storefrontAuthRouter);
// /plans and /brand are public; /orders + /subscriptions inline authCustomer.
storefrontRouter.use('/', storefrontPlansRouter);
