import { config } from '../config';
import { logger } from './logger';

// TODO: implement SQLite + PG dual-driver wrapper.
// For now, a stub that logs the chosen driver.

export async function initDatabase(): Promise<void> {
  logger.info(
    { type: config.databaseType, url: config.databaseUrl.replace(/:.*@/, ':***@') },
    'database:init',
  );
  // PG: pool = new Pool({ connectionString: config.databaseUrl })
  // SQLite: db = new Database(config.databaseUrl)
}

export function getDb(): unknown {
  throw new Error('database not initialized');
}
