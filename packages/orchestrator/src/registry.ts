import { readFile } from 'node:fs/promises';
import type { CredentialStore, EngineCredential, InstanceInfo } from '@relay-panel/adapter-core';

/**
 * 站点注册表：开发期用一个 JSON 文件描述接入的实例（生产走编排器 DB sites 表）。
 * 凭据引用两种：
 *  - "db:<database>" —— 从 PG@5440 该库 settings.admin_api_key 读（生产站）
 *  - "devfile:<path>" —— 开发站的明文 credentials.json（admin-password）
 */
export interface SiteEntry {
  slug: string;
  label: string;
  engine: 'sub2api' | 'newapi';
  baseUrl: string;
  credentialRef: string;
}

export interface RegistryFile {
  sites: SiteEntry[];
  /** 读 db:<database> 凭据用的 PG 连接（不含库名） */
  credentialDb?: { host: string; port: number; user: string; passwordFile: string; passwordPattern: string };
}

export async function loadRegistry(path: string): Promise<RegistryFile> {
  return JSON.parse(await readFile(path, 'utf8')) as RegistryFile;
}

export function entryToInstance(e: SiteEntry): InstanceInfo {
  return {
    siteSlug: e.slug,
    engine: e.engine,
    version: 'prod',
    baseUrl: e.baseUrl,
    dataDir: '',
    composeProject: '',
    credentialRef: e.credentialRef,
  };
}

/** 解析 db:/devfile: 两种凭据引用；db 密码从文件按正则抠，绝不入日志 */
export function makeCredentialStore(reg: RegistryFile): CredentialStore {
  let dbPassword: string | null = null;
  const pgFactory = async () => {
    const pg = (await import('pg')).default;
    if (dbPassword === null) {
      if (!reg.credentialDb) throw new Error('registry has no credentialDb for db: refs');
      const text = await readFile(reg.credentialDb.passwordFile, 'utf8');
      const m = text.match(new RegExp(reg.credentialDb.passwordPattern));
      if (!m?.[1]) throw new Error('credentialDb password not found by pattern');
      dbPassword = m[1];
    }
    return pg;
  };

  return {
    async resolve(ref: string): Promise<EngineCredential> {
      if (ref.startsWith('devfile:')) {
        const file = JSON.parse(await readFile(ref.slice('devfile:'.length), 'utf8'));
        if (file.adminApiKey) return { kind: 'admin-token', secret: file.adminApiKey };
        return { kind: 'admin-password', secret: file.adminPassword, adminEmail: file.adminEmail };
      }
      if (ref.startsWith('db:')) {
        const pg = await pgFactory();
        const c = new pg.Client({
          host: reg.credentialDb!.host,
          port: reg.credentialDb!.port,
          user: reg.credentialDb!.user,
          password: dbPassword!,
          database: ref.slice('db:'.length),
        });
        await c.connect();
        try {
          const r = await c.query(`SELECT value FROM settings WHERE key='admin_api_key'`);
          const key = r.rows[0]?.value;
          if (!key) throw new Error(`admin_api_key not set in ${ref}`);
          return { kind: 'admin-token', secret: key };
        } finally {
          await c.end();
        }
      }
      throw new Error(`unknown credentialRef scheme: ${ref}`);
    },
  };
}
