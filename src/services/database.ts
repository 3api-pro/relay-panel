/**
 * Postgres pool wrapper. Single-tenant uses tenant_id=1 implicitly via
 * tenant-resolver middleware. Multi-tenant uses subdomain → tenant_id.
 */
import { Pool, PoolClient, QueryResultRow } from 'pg';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

let pool: Pool | null = null;

export async function initDatabase(): Promise<void> {
  if (pool) return;
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // Warm test
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
  logger.info({ url: maskUrl(config.databaseUrl) }, 'database:connected');

  await runMigrations();
  await ensureDefaultTenant();
}

export function getPool(): Pool {
  if (!pool) throw new Error('database not initialized — call initDatabase() first');
  return pool;
}

export async function query<T extends QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const migDir = path.resolve(__dirname, '../../db/migrations');
  if (!fs.existsSync(migDir)) {
    logger.warn({ migDir }, 'database:migrations:dir_missing');
    return;
  }
  const files = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    try {
      await getPool().query(sql);
      logger.info({ file: f }, 'database:migration:applied');
    } catch (err: any) {
      logger.error({ err: err.message, file: f }, 'database:migration:failed');
      throw err;
    }
  }
}

async function ensureDefaultTenant(): Promise<void> {
  if (config.tenantMode === 'single') {
    await getPool().query(
      `INSERT INTO tenant (id, slug, status) VALUES (1, 'default', 'active')
         ON CONFLICT (id) DO NOTHING`,
    );
  }
}

function maskUrl(url: string): string {
  return url.replace(/:[^@]*@/, ':***@');
}
