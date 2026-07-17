import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { makeDb, runMigrations, type Db } from '../db/client.js';
import { operators } from '../db/schema.js';
import { hashPassword } from '../auth/passwords.js';
import { randomPassword } from '../secrets.js';
import { importRegistry } from '../registryImport.js';
import { importTemplates } from '../marketplace/grant.js';

/**
 * 管理子命令（规格 §10）：
 *   create-admin <email>       — 建 root；密码取 env RP_NEW_PASSWORD，缺省生成并打印一次
 *   import-registry <path>     — registry.json → DB（sites external + credential_db 设置），幂等
 *   import-templates <path>    — 渠道市场模板 JSON 批量 upsert（key 幂等）
 */

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const db = await makeDb(config.dbUrl);
  try {
    await runMigrations(db);
    return await fn(db);
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function createAdmin(email: string): Promise<number> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('create-admin: 邮箱格式无效');
    return 1;
  }
  // 密码来源：env 优先；缺省生成 24 位强随机
  const fromEnv = process.env.RP_NEW_PASSWORD;
  const password = fromEnv && fromEnv.length > 0 ? fromEnv : randomPassword(24);

  return withDb(async (db) => {
    const dup = await db.orm.select({ id: operators.id }).from(operators).where(eq(operators.email, email)).limit(1);
    if (dup.length > 0) {
      console.error(`create-admin: 邮箱已存在: ${email}`);
      return 1;
    }
    await db.orm.insert(operators).values({
      email,
      passwordHash: await hashPassword(password),
      role: 'root',
      status: 'active',
    });
    console.log(`root 账号已创建: ${email}`);
    if (!fromEnv) {
      // 唯一一次输出生成的初始密码（env 提供的密码绝不回显）
      console.log(`初始密码（仅此一次显示，请登录后立即修改）: ${password}`);
    }
    return 0;
  });
}

export async function runAdminCommand(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;

  if (cmd === 'create-admin' && arg) {
    return createAdmin(arg);
  }

  if (cmd === 'import-registry' && arg) {
    return withDb(async (db) => {
      const result = await importRegistry(db, arg);
      console.log(`导入完成: sites=${result.sites}, credentialDb=${result.credentialDb ? '已写入' : '无'}`);
      return 0;
    });
  }

  if (cmd === 'import-templates' && arg) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(arg, 'utf8'));
    } catch (err) {
      console.error(`import-templates: 文件读取/解析失败: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    return withDb(async (db) => {
      try {
        const result = await importTemplates(db, parsed);
        console.log(`模板导入完成: 新增 ${result.inserted}, 更新 ${result.updated}`);
        return 0;
      } catch (err) {
        console.error(`import-templates: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    });
  }

  console.log('usage: create-admin <email> | import-registry <path> | import-templates <path>');
  return 1;
}
