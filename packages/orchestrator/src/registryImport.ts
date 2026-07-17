import { readFile } from 'node:fs/promises';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { appSettings, operators, sites } from './db/schema.js';

/**
 * registry.json（P1 文件注册表）→ DB 导入（规格 §1/§10 import-registry）。
 * 幂等：slug 冲突则更新 label/baseUrl/credentialRef；credential_db 设置整体覆盖。
 * 导入的站 managed='external'（只读生命周期），归属第一个 root operator。
 */

interface RegistrySiteEntry {
  slug: string;
  label: string;
  engine: string;
  baseUrl: string;
  credentialRef: string;
}

interface RegistryJson {
  sites?: RegistrySiteEntry[];
  credentialDb?: Record<string, unknown>;
}

export interface ImportRegistryResult {
  sites: number;
  credentialDb: boolean;
}

/** baseUrl 解析不出显式端口时记 0（external 站不参与端口池分配） */
function parseHostPort(baseUrl: string): number {
  try {
    const u = new URL(baseUrl);
    return u.port ? Number(u.port) : 0;
  } catch {
    return 0;
  }
}

export async function importRegistry(db: Db, path: string): Promise<ImportRegistryResult> {
  const reg = JSON.parse(await readFile(path, 'utf8')) as RegistryJson;

  const roots = await db.orm
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.role, 'root'))
    .orderBy(asc(operators.id))
    .limit(1);
  const root = roots[0];
  if (!root) throw new Error('no root operator; run create-admin first');

  if (reg.credentialDb) {
    await db.orm
      .insert(appSettings)
      .values({ key: 'credential_db', value: reg.credentialDb })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: reg.credentialDb, updatedAt: sql`now()` },
      });
  }

  const entries = reg.sites ?? [];
  for (const e of entries) {
    await db.orm
      .insert(sites)
      .values({
        operatorId: root.id,
        slug: e.slug,
        label: e.label,
        engine: e.engine,
        version: 'prod', // 存量站版本未知，沿用 P1 registry 的占位语义
        hostPort: parseHostPort(e.baseUrl),
        baseUrl: e.baseUrl,
        credentialRef: e.credentialRef,
        managed: 'external',
        status: 'active', // 存量站视为在跑；真实健康以快照实时探测为准
      })
      .onConflictDoUpdate({
        target: sites.slug,
        set: {
          label: e.label,
          baseUrl: e.baseUrl,
          credentialRef: e.credentialRef,
          updatedAt: sql`now()`,
        },
      });
  }

  return { sites: entries.length, credentialDb: Boolean(reg.credentialDb) };
}
