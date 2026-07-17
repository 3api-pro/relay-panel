import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type OrchestratorSchema = typeof schema;

/**
 * 统一的 drizzle 句柄类型：pg / pglite 两个后端的实例都收敛到 PgDatabase 供下游使用
 * （两者仅 QueryResultHKT 不同，查询构建 API 一致；构造处窄化一次 cast，下游零 cast）。
 */
export type Orm = PgDatabase<PgQueryResultHKT, OrchestratorSchema>;

export interface Db {
  orm: Orm;
  kind: 'pg' | 'pglite';
  /** 执行原始 SQL（支持一段里多条语句；迁移用） */
  exec(sql: string): Promise<void>;
  /** 参数化原始查询（占位符 $1..$n） */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * makeDb 支持三种 url：
 *  - postgres://…      生产（node-postgres Pool）
 *  - pglite:<dir>      单机自部署零依赖
 *  - pglite:memory     测试专用内存库
 */
export async function makeDb(url: string): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: url });
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const orm = drizzle(pool, { schema });
    return {
      orm: orm as unknown as Orm,
      kind: 'pg',
      async exec(sql) {
        await pool.query(sql);
      },
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const res = await pool.query(sql, params as never[]);
        return res.rows as T[];
      },
      async close() {
        await pool.end();
      },
    };
  }

  if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = target === 'memory' ? new PGlite() : new PGlite(target);
    const { drizzle } = await import('drizzle-orm/pglite');
    const orm = drizzle(lite, { schema });
    return {
      orm: orm as unknown as Orm,
      kind: 'pglite',
      async exec(sql) {
        await lite.exec(sql);
      },
      async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        const res = await lite.query<T>(sql, params);
        return res.rows;
      },
      async close() {
        await lite.close();
      },
    };
  }

  throw new Error(`unsupported RP_DB url scheme: ${url.split(':')[0] ?? url}`);
}

/** tsc 不搬 .sql，dist 下运行时回退到源码树定位（模式同 index.ts 对 ui 目录的处理） */
function locateMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/src/db 或 <pkg>/dist/db
  const candidates = [join(here, 'migrations'), join(here, '..', '..', 'src', 'db', 'migrations')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('migrations directory not found (src/db/migrations)');
}

/**
 * 迷你迁移器：按文件名序执行 migrations/*.sql，schema_migrations 记账，幂等。
 * 返回本次实际执行的文件名列表。
 */
export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT now())`,
  );
  const dir = locateMigrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(appliedRows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec(sql);
    await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    ran.push(file);
  }
  return ran;
}
