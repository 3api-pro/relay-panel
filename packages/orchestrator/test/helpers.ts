import type { FastifyInstance } from 'fastify';
import type { EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import { loadConfig, type Config } from '../src/config.js';
import { makeDb, runMigrations, type Db } from '../src/db/client.js';
import { operators } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/passwords.js';
import { JobEngine } from '../src/jobs/engine.js';
import { buildServer } from '../src/server.js';
import { FakeAdapter, FakeGateway, FakeLifecycle, FakeNotifier } from './fakes.js';

/** pglite 内存库 + 全量迁移；每个用例独立库，用完 db.close() */
export async function makeTestDb(): Promise<Db> {
  const db = await makeDb('pglite:memory');
  await runMigrations(db);
  return db;
}

/** 全默认值 Config（不读 process.env），可按需覆盖；secretKey 预置测试值 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({});
  return { ...base, dbUrl: 'pglite:memory', secretKey: 'test-master-key', ...overrides };
}

let operatorSeq = 1;

/** 插入一个 operator（默认 root/active），返回 id */
export async function seedOperator(
  db: Db,
  opts: { email?: string; role?: 'root' | 'operator' | 'viewer'; status?: 'active' | 'disabled' } = {},
): Promise<number> {
  const rows = await db.orm
    .insert(operators)
    .values({
      email: opts.email ?? `op-${operatorSeq++}@example.com`,
      role: opts.role ?? 'root',
      status: opts.status ?? 'active',
    })
    .returning({ id: operators.id });
  return rows[0]!.id;
}

export interface MakeTestServerOverrides {
  /** 覆盖 Config 字段（signupMode/metricsToken 等） */
  config?: Partial<Config>;
  /** 复用外部 db（缺省新建 pglite:memory + migrate；close() 时一并关闭） */
  db?: Db;
}

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  config: Config;
  adapters: Record<EngineKind, FakeAdapter>;
  lifecycles: Record<EngineKind, FakeLifecycle>;
  gateway: FakeGateway;
  notifier: FakeNotifier;
  jobs: JobEngine;
  /** 建 operator（带口令散列）并登录，返回 rp_session cookie 值 */
  seedLogin(opts: {
    email: string;
    password: string;
    role?: 'root' | 'operator' | 'viewer';
    status?: 'active' | 'disabled';
  }): Promise<{ operatorId: number; cookie: string }>;
  /** 对已存在账号登录，返回 rp_session cookie 值 */
  login(email: string, password: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * buildServer + pglite 内存库 + fake 依赖注入的一站式测试服务。
 * 用法：const ts = await makeTestServer(); ts.app.inject({ ..., cookies: { rp_session: cookie } })。
 */
export async function makeTestServer(overrides: MakeTestServerOverrides = {}): Promise<TestServer> {
  const ownDb = overrides.db === undefined;
  const db = overrides.db ?? (await makeTestDb());
  const config = makeTestConfig(overrides.config);
  const adapters: Record<EngineKind, FakeAdapter> = {
    sub2api: new FakeAdapter('sub2api'),
    newapi: new FakeAdapter('newapi'),
  };
  const lifecycles: Record<EngineKind, FakeLifecycle> = {
    sub2api: new FakeLifecycle('sub2api'),
    newapi: new FakeLifecycle('newapi'),
  };
  const gateway = new FakeGateway();
  const notifier = new FakeNotifier();
  const jobs = new JobEngine(db);

  const app = await buildServer({
    config,
    db,
    // FakeAdapter/FakeLifecycle 结构化实现 EngineAdapter/EngineLifecycle
    adapters: adapters as Record<EngineKind, EngineAdapter>,
    lifecycles: lifecycles as Record<EngineKind, EngineLifecycle>,
    gateway,
    jobs,
    notifier,
  });
  await app.ready();

  async function login(email: string, password: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    if (res.statusCode !== 200) {
      throw new Error(`test login failed: HTTP ${res.statusCode}`);
    }
    const cookie = res.cookies.find((c) => c.name === 'rp_session');
    if (!cookie) throw new Error('test login: no rp_session cookie in response');
    return cookie.value;
  }

  return {
    app,
    db,
    config,
    adapters,
    lifecycles,
    gateway,
    notifier,
    jobs,
    login,
    async seedLogin(opts) {
      const rows = await db.orm
        .insert(operators)
        .values({
          email: opts.email,
          passwordHash: await hashPassword(opts.password),
          role: opts.role ?? 'root',
          status: opts.status ?? 'active',
        })
        .returning({ id: operators.id });
      const cookie = await login(opts.email, opts.password);
      return { operatorId: rows[0]!.id, cookie };
    },
    async close() {
      jobs.stop();
      await app.close().catch(() => undefined);
      if (ownDb) await db.close().catch(() => undefined);
    },
  };
}
