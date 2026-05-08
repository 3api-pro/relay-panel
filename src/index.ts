/**
 * 3API Relay Panel — entry point
 * Single-tenant default; multi-tenant via TENANT_MODE=multi.
 */
import express from 'express';
import dotenv from 'dotenv';
import { initDatabase } from './services/database';
import { config } from './config';
import { logger } from './services/logger';

dotenv.config();

async function main(): Promise<void> {
  await initDatabase();

  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, tenant_mode: config.tenantMode, version: '0.1.0-alpha' });
  });

  // TODO: mount tenant resolver, admin routes, customer routes, relay routes

  app.listen(config.port, () => {
    logger.info(
      { port: config.port, tenantMode: config.tenantMode },
      '3api-panel:listening',
    );
  });
}

main().catch((err) => {
  logger.error({ err }, '3api-panel:fatal');
  process.exit(1);
});
