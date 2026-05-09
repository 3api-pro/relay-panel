/**
 * 3API Relay Panel — entry point.
 * Single-tenant default; multi-tenant via TENANT_MODE=multi.
 */
import express from 'express';
// dotenv loaded via dynamic require to avoid type dep:
import { initDatabase } from './services/database';
import { config } from './config';
import { logger } from './services/logger';
import { tenantResolver } from './middleware/tenant-resolver';
import { authToken } from './middleware/auth-token';
import { relayRouter } from './routes/relay';
import { adminAuthRouter } from './routes/auth-admin';
import { adminRouter } from './routes/admin';
import { authAdmin } from './middleware/auth-admin';
import { customerAuthRouter } from './routes/auth-customer';
import { customerRouter } from './routes/customer';
import { authCustomer } from './middleware/auth-customer';
import { platformRouter } from './routes/platform';
import { ensureDefaultAdmin } from './services/auth';

try { require('dotenv').config(); } catch {}

async function main(): Promise<void> {
  await initDatabase();
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


  // /admin/login + /admin/logout — public (no auth required, just tenant)
  app.use('/admin', tenantResolver, adminAuthRouter);

  // /admin/* — protected admin routes
  app.use('/admin', tenantResolver, authAdmin, adminRouter);


  // /customer/signup + /customer/login — public (no auth, just tenant)
  app.use('/customer', tenantResolver, customerAuthRouter);

  // /customer/* — protected customer self-service
  app.use('/customer', tenantResolver, authCustomer, customerRouter);

  // /platform/* — platform-operator only (no tenant resolver, X-Platform-Token header).
  app.use('/platform', platformRouter);

  // /v1/* — relay path: tenant resolver → token auth → upstream proxy
  app.use('/v1', tenantResolver, authToken, relayRouter);

  // 404 fallback
  app.use((_req, res) => {
    res.status(404).json({ error: { type: 'not_found', message: 'Route not found' } });
  });

  // Generic error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message ?? String(err) }, 'unhandled_error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  });

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
