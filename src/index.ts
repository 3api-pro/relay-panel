/**
 * 3API Relay Panel — entry point.
 * Single-tenant default; multi-tenant via TENANT_MODE=multi.
 */
import path from 'path';
import fs from 'fs';
import express, { Router } from 'express';
// dotenv loaded via dynamic require to avoid type dep:
import { initDatabase } from './services/database';
import { config } from './config';
import { logger } from './services/logger';
import { tenantResolver, requireTenantHost } from './middleware/tenant-resolver';
import { authToken } from './middleware/auth-token';
import { relayRouter } from './routes/relay';
import { adminAuthRouter } from './routes/auth-admin';
import { ssoLlmapiRouter } from './routes/sso-llmapi';
import { adminWalletRouter } from './routes/admin/wallet';
import { platformWithdrawalsRouter } from './routes/platform/withdrawals';
import { adminRouter } from './routes/admin';
import { authAdmin } from './middleware/auth-admin';
import { customerAuthRouter } from './routes/auth-customer';
import { customerRouter } from './routes/customer';
import { authCustomer } from './middleware/auth-customer';
import { platformRouter } from './routes/platform';
import { signupTenantRouter } from './routes/signup-tenant';
import { landingRouter } from "./routes/landing";
import { embedRouter } from "./routes/embed";
import { storefrontRouter } from "./routes/storefront";
import { paymentsRouter, storefrontPaymentsRouter } from "./routes/payments";
import { ensureDefaultAdmin } from './services/auth';
import { initAppConfig } from './services/app-config';
import { initEmailPolicy } from './services/email-policy';
import { startUsdtWatcher } from "./services/payments/usdt-watcher";
import { startEmailCron } from "./services/email-cron";
import { startWholesaleSync } from "./services/wholesale-sync";
import { startWebhookWorker } from "./services/webhook";
import { openapiRouter } from "./routes/openapi";

try { require('dotenv').config(); } catch {}

async function main(): Promise<void> {
  await initDatabase();
  await initAppConfig();
  await initEmailPolicy();
  await ensureDefaultAdmin();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: '0.1.0-alpha',
      tenant_mode: config.tenantMode,
    });
  });

  // Iframe-embeddable mini buy-box widget. Mounted before landing so the
  // root-domain catch-all doesn't try to claim /embed/* paths.
  app.use('/embed', embedRouter);

  // Marketing landing on the SaaS root domain (3api.pro / www).
  // Subdomains and single-tenant deploys fall through.
  app.use('/', landingRouter);
  app.use('/sso', ssoLlmapiRouter);

  // ---------------------------------------------------------------------
  // Static UI — Next.js export at /app/public, GET-only.
  //
  // Mounted BEFORE the API so a browser hitting GET /admin/login on a
  // subdomain gets the rendered Next page instead of authAdmin's 401.
  // POST /admin/login etc. fall through (express.static is GET/HEAD only).
  // ---------------------------------------------------------------------
  const UI_DIR = path.resolve(__dirname, '../public');
  if (fs.existsSync(UI_DIR)) {
    app.use(express.static(UI_DIR, { index: 'index.html', extensions: ['html'] }));
    // Next emits per-route `name/index.html` files (trailingSlash:true).
    // Dispatch GET /login → /login/index.html, /admin/login → /admin/login/index.html.
    app.get(/^\/[^.]*$/, (req, res, next) => {
      const candidate = path.join(UI_DIR, req.path, 'index.html');
      if (fs.existsSync(candidate)) return res.sendFile(candidate);
      return next();
    });
  } else {
    logger.warn({ uiDir: UI_DIR }, 'ui:not_built — run `npm --prefix ui run build` and rebuild the image');
  }

  // ---------------------------------------------------------------------
  // API mounts.
  //
  // Two paths reach the same handlers:
  //   /api/{admin,customer,v1,platform}/...   — used by the bundled UI (lib/api.ts)
  //   /{admin,customer,v1,platform}/...       — stable, callable by curl / SDKs
  // ---------------------------------------------------------------------
  function mountApi(router: express.Router): void {
    router.use('/admin', tenantResolver, adminAuthRouter);
    router.use('/admin/wallet', tenantResolver, adminWalletRouter);
    router.use('/admin', tenantResolver, authAdmin, adminRouter);
    router.use('/customer', tenantResolver, requireTenantHost, customerAuthRouter);
    router.use('/customer', tenantResolver, requireTenantHost, authCustomer, customerRouter);
    router.use('/v1', tenantResolver, requireTenantHost, authToken, relayRouter);
    router.use('/platform', platformRouter);
    router.use('/platform/withdrawals', platformWithdrawalsRouter);
    router.use("/signup-tenant", signupTenantRouter);
    router.use("/storefront", tenantResolver, requireTenantHost, storefrontRouter);
    // Authed storefront payment endpoints (requires tenant + JWT).
    router.use("/storefront/payments", tenantResolver, requireTenantHost, storefrontPaymentsRouter);
    // Public payment webhooks (no tenant resolution; provider posts raw).
    router.use("/payments", paymentsRouter);
  }
  const apiRouter = Router();
  mountApi(apiRouter);
  app.use('/api', apiRouter);

  // OpenAPI YAML — public, no auth (so swagger-ui-react / curl can grab it).
  app.use('/', openapiRouter);
  mountApi(app as unknown as express.Router);

  // 404 fallback. HTML for browser-ish requests, JSON for SDK paths.
  app.use((req, res) => {
    if (
      req.accepts('html') &&
      !req.path.startsWith('/api') &&
      !req.path.startsWith('/v1')
    ) {
      const html = path.join(UI_DIR, '404.html');
      if (fs.existsSync(html)) return res.status(404).sendFile(html);
    }
    res.status(404).json({ error: { type: 'not_found', message: 'Route not found' } });
  });

  // Generic error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message ?? String(err) }, 'unhandled_error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  });

  // Background workers — soft-fail safe.
  try { startUsdtWatcher(); } catch (e: any) { logger.warn({ err: e.message }, 'usdt:watcher:start:fail'); }
  try { startEmailCron(); } catch (e: any) { logger.warn({ err: e.message }, 'email:cron:start:fail'); }
  try { startWholesaleSync(); } catch (e: any) { logger.warn({ err: e.message }, 'wholesale:sync:start:fail'); }
  try { startWebhookWorker(); } catch (e: any) { logger.warn({ err: e.message }, 'webhook:worker:start:fail'); }

  app.listen(config.port, () => {
    logger.info(
      { port: config.port, tenantMode: config.tenantMode },
      '3api-panel:listening',
    );
  });
}

main().catch((err) => {
  logger.error({ err: err?.message ?? String(err) }, '3api-panel:fatal');
  process.exit(1);
});
