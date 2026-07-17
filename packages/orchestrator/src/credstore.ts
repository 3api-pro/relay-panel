import { readFile } from 'node:fs/promises';
import type { CredentialStore, EngineCredential } from '@relay-panel/adapter-core';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { decryptSecret } from './secrets.js';

/**
 * 凭据引用解析 V2（DB 版，取代 registry.ts 的文件版）。三种 scheme：
 *  - "enc:<slug>"     credentials 表密文（AES-256-GCM）→ 解密 JSON → EngineCredential
 *  - "devfile:<path>" 开发站明文 credentials.json（仅本机测试）
 *  - "db:<database>"  从存量站引擎库 settings.admin_api_key 读（连接参数在 app_settings['credential_db']）
 * 密码/密钥只在内存流转，绝不入日志与错误信息。
 */

/** app_settings['credential_db'] 的 JSON 形状（registry 导入时原样写入） */
interface CredentialDbSettings {
  host: string;
  port: number;
  user: string;
  passwordFile: string;
  passwordPattern: string;
}

/**
 * 解密后的凭据 JSON → EngineCredential 映射：
 *  - adminApiKey 存在 → admin-token
 *  - 否则 admin-password；adminEmail 取 adminEmail（sub2api lifecycle 存法）
 *    或 adminUsername（newapi lifecycle 存法，引擎用 username 登录）
 */
function toEngineCredential(ref: string, file: Record<string, unknown>): EngineCredential {
  if (typeof file.adminApiKey === 'string' && file.adminApiKey) {
    return { kind: 'admin-token', secret: file.adminApiKey };
  }
  if (typeof file.adminPassword !== 'string' || !file.adminPassword) {
    throw new Error(`credential ${ref} has neither adminApiKey nor adminPassword`);
  }
  const adminEmail =
    typeof file.adminEmail === 'string' && file.adminEmail
      ? file.adminEmail
      : typeof file.adminUsername === 'string' && file.adminUsername
        ? file.adminUsername
        : undefined;
  return {
    kind: 'admin-password',
    secret: file.adminPassword,
    ...(adminEmail !== undefined ? { adminEmail } : {}),
  };
}

export function makeCredentialStoreV2(db: Db, config: Config): CredentialStore {
  // db: 引用的连接密码按需读取并缓存进程内
  let credDb: CredentialDbSettings | null = null;
  let credDbPassword: string | null = null;

  async function loadCredentialDb(): Promise<CredentialDbSettings> {
    if (credDb) return credDb;
    const rows = await db.query<{ value: CredentialDbSettings }>(
      `SELECT value FROM app_settings WHERE key = 'credential_db'`,
    );
    const value = rows[0]?.value;
    if (!value) throw new Error(`app_settings['credential_db'] not configured; cannot resolve db: refs`);
    credDb = value;
    return value;
  }

  async function loadCredDbPassword(settings: CredentialDbSettings): Promise<string> {
    if (credDbPassword !== null) return credDbPassword;
    const text = await readFile(settings.passwordFile, 'utf8');
    const m = text.match(new RegExp(settings.passwordPattern));
    if (!m?.[1]) throw new Error('credential_db password not found by pattern');
    credDbPassword = m[1];
    return credDbPassword;
  }

  return {
    async resolve(ref: string): Promise<EngineCredential> {
      if (ref.startsWith('enc:')) {
        if (!config.secretKey) {
          throw new Error('RP_SECRET_KEY not set; cannot resolve enc: credentials');
        }
        const rows = await db.query<{ ciphertext: string }>(
          `SELECT ciphertext FROM credentials WHERE ref = $1`,
          [ref],
        );
        const ciphertext = rows[0]?.ciphertext;
        if (!ciphertext) throw new Error(`credential not found: ${ref}`);
        const file = JSON.parse(decryptSecret(ciphertext, config.secretKey)) as Record<string, unknown>;
        return toEngineCredential(ref, file);
      }

      if (ref.startsWith('devfile:')) {
        const file = JSON.parse(await readFile(ref.slice('devfile:'.length), 'utf8')) as Record<
          string,
          unknown
        >;
        return toEngineCredential(ref, file);
      }

      if (ref.startsWith('db:')) {
        const settings = await loadCredentialDb();
        const password = await loadCredDbPassword(settings);
        const pg = (await import('pg')).default;
        const client = new pg.Client({
          host: settings.host,
          port: settings.port,
          user: settings.user,
          password,
          database: ref.slice('db:'.length),
        });
        await client.connect();
        try {
          const r = await client.query(`SELECT value FROM settings WHERE key='admin_api_key'`);
          const key = (r.rows[0] as { value?: string } | undefined)?.value;
          if (!key) throw new Error(`admin_api_key not set in ${ref}`);
          return { kind: 'admin-token', secret: key };
        } finally {
          await client.end();
        }
      }

      throw new Error(`unknown credentialRef scheme: ${ref.split(':')[0] ?? ref}`);
    },
  };
}
