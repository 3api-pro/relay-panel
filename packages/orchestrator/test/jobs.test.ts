import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { jobs, sites, type JobRow } from '../src/db/schema.js';
import { JobEngine, redactText } from '../src/jobs/engine.js';
import { registerJobsRoutes, type SessionCtxLike } from '../src/jobs/routes.js';
import { makeTestDb, seedOperator } from './helpers.js';

// pglite WASM 冷启动约 4s，整文件共享一个库并放宽超时
vi.setConfig({ testTimeout: 30_000 });

let db: Db;

beforeAll(async () => {
  db = await makeTestDb();
}, 60_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
});

afterEach(async () => {
  // 兜底清理未终态的 job，避免污染其它用例的 tick
  await db.orm
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(inArray(jobs.status, ['queued', 'running']));
});

async function getJob(id: number): Promise<JobRow> {
  const rows = await db.orm.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  expect(rows[0]).toBeDefined();
  return rows[0]!;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('redactText', () => {
  it('键值对形态的敏感值被打码', () => {
    expect(redactText('password=abc123')).toBe('password=<redacted>');
    expect(redactText('apiKey: sk-1234567890abcdef end')).toBe('apiKey: <redacted> end');
    expect(redactText('login failed: token=sk-abc123def456 password=hunter2')).toBe(
      'login failed: token=<redacted> password=<redacted>',
    );
  });

  it('裸 sk- 形态的 key 被打码，普通文本不动', () => {
    expect(redactText('bare sk-1234567890abcdef end')).toBe('bare <redacted> end');
    expect(redactText('no secrets here monkey=banana')).toBe('no secrets here monkey=banana');
  });
});

describe('JobEngine: 执行与状态', () => {
  it('enqueue 落 queued，tick 执行后 succeeded 且 steps/时间戳齐全', async () => {
    const engine = new JobEngine(db);
    engine.registerHandler('provision', async (_job, onStep) => {
      await onStep('render', 'ok');
      await onStep('compose-up', 'ok', 'project rp-site-a');
    });

    const id = await engine.enqueue('provision', 'exec-a', { version: 'v1.0.0' }, 'root@example.com');
    expect(id).toBeGreaterThan(0);
    expect((await getJob(id)).status).toBe('queued');

    await engine.tick();
    await engine.idle();

    const row = await getJob(id);
    expect(row.status).toBe('succeeded');
    expect(row.startedAt).toBeTruthy();
    expect(row.finishedAt).toBeTruthy();
    expect(row.error).toBeNull();
    expect(row.steps.map((s) => s.step)).toEqual(['render', 'compose-up']);
    expect(row.steps[1]!.detail).toBe('project rp-site-a');
    expect(row.steps.every((s) => typeof s.at === 'string' && s.at.length > 0)).toBe(true);
  });

  it('handler 抛错 → failed，error 与 step detail 均不含明文凭据', async () => {
    const engine = new JobEngine(db);
    engine.registerHandler('start', async (_job, onStep) => {
      await onStep('login', 'fail', 'attempt with password=hunter2secret failed');
      throw new Error('upstream rejected: token=sk-abc123def456 password=hunter2secret');
    });

    const id = await engine.enqueue('start', 'exec-b', undefined, 'root@example.com');
    await engine.tick();
    await engine.idle();

    const row = await getJob(id);
    expect(row.status).toBe('failed');
    expect(row.error).not.toContain('hunter2secret');
    expect(row.error).not.toContain('sk-abc123def456');
    expect(row.error).toContain('<redacted>');
    const detail = row.steps[0]!.detail ?? '';
    expect(detail).not.toContain('hunter2secret');
    expect(detail).toContain('<redacted>');
    // 全行序列化兜底自查：任何字段都不得携带明文
    expect(JSON.stringify(row)).not.toContain('hunter2secret');
  });

  it('未注册 handler 的 kind → failed 并注明原因', async () => {
    const engine = new JobEngine(db);
    const id = await engine.enqueue('upgrade', 'exec-c', undefined, 'root@example.com');
    await engine.tick();
    await engine.idle();
    const row = await getJob(id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('upgrade');
  });

  it('onFinish 回调在成功与失败终态都触发，拿到终态行', async () => {
    const finished: JobRow[] = [];
    const engine = new JobEngine(db, {
      onFinish: (job) => {
        finished.push(job);
      },
    });
    engine.registerHandler('stop', async () => {});
    engine.registerHandler('destroy', async () => {
      throw new Error('boom password=leak123');
    });

    const okId = await engine.enqueue('stop', 'fin-a', undefined, 'root@example.com');
    const badId = await engine.enqueue('destroy', 'fin-b', undefined, 'root@example.com');
    await engine.tick();
    await engine.idle();

    expect(finished.map((j) => j.id).sort((a, b) => a - b)).toEqual(
      [okId, badId].sort((a, b) => a - b),
    );
    expect(finished.find((j) => j.id === okId)!.status).toBe('succeeded');
    const bad = finished.find((j) => j.id === badId)!;
    expect(bad.status).toBe('failed');
    expect(bad.error).not.toContain('leak123');
  });
});

describe('JobEngine: 去重 / 串行 / 并发', () => {
  it('同 slug 存在 queued/running 时 enqueue 抛 statusCode=409，完成后可再入队', async () => {
    const engine = new JobEngine(db);
    const gate = deferred();
    engine.registerHandler('provision', async () => {
      await gate.promise;
    });

    const id1 = await engine.enqueue('provision', 'dup-a', undefined, 'root@example.com');
    // queued 阶段重复入队（换 kind 也不行）
    await expect(
      engine.enqueue('start', 'dup-a', undefined, 'root@example.com'),
    ).rejects.toMatchObject({ statusCode: 409 });

    await engine.tick();
    // running 阶段同样 409
    await expect(
      engine.enqueue('start', 'dup-a', undefined, 'root@example.com'),
    ).rejects.toMatchObject({ statusCode: 409 });

    gate.resolve();
    await engine.idle();
    expect((await getJob(id1)).status).toBe('succeeded');

    // 终态后同 slug 可再入队
    const id2 = await engine.enqueue('start', 'dup-a', undefined, 'root@example.com');
    expect(id2).toBeGreaterThan(id1);
  });

  it('同 slug 串行：两条 queued（绕过 enqueue 直插）严格先后执行、绝不并行', async () => {
    const engine = new JobEngine(db);
    const events: string[] = [];
    const gates: { promise: Promise<void>; resolve: () => void }[] = [];
    engine.registerHandler('upgrade', async (job) => {
      events.push(`start:${job.id}`);
      const d = deferred();
      gates.push(d);
      await d.promise;
      events.push(`end:${job.id}`);
    });

    // 模拟重启恢复等来源：DB 里同 slug 已有两条 queued
    const j1 = (
      await db.orm
        .insert(jobs)
        .values({ kind: 'upgrade', slug: 'serial-a', createdBy: 'system' })
        .returning({ id: jobs.id })
    )[0]!.id;
    const j2 = (
      await db.orm
        .insert(jobs)
        .values({ kind: 'upgrade', slug: 'serial-a', createdBy: 'system' })
        .returning({ id: jobs.id })
    )[0]!.id;

    await engine.tick();
    expect(engine.runningCount).toBe(1);
    // 第一条还在跑时再 tick，同 slug 第二条不得被派发
    await engine.tick();
    expect(engine.runningCount).toBe(1);
    expect((await getJob(j2)).status).toBe('queued');

    await vi.waitFor(() => {
      expect(gates.length).toBe(1);
    });
    gates[0]!.resolve();
    await engine.idle();

    await engine.tick();
    await vi.waitFor(() => {
      expect(gates.length).toBe(2);
    });
    gates[1]!.resolve();
    await engine.idle();

    expect(events).toEqual([`start:${j1}`, `end:${j1}`, `start:${j2}`, `end:${j2}`]);
    expect((await getJob(j1)).status).toBe('succeeded');
    expect((await getJob(j2)).status).toBe('succeeded');
  });

  it('全局并发上限 2：三个不同 slug 同时入队最多 2 个 running', async () => {
    const engine = new JobEngine(db);
    const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    engine.registerHandler('start', async (job) => {
      const d = deferred();
      gates.set(job.slug, d);
      await d.promise;
    });

    const idA = await engine.enqueue('start', 'conc-a', undefined, 'root@example.com');
    const idB = await engine.enqueue('start', 'conc-b', undefined, 'root@example.com');
    const idC = await engine.enqueue('start', 'conc-c', undefined, 'root@example.com');

    await engine.tick();
    expect(engine.runningCount).toBe(2);
    // 已满员时再 tick 不超发
    await engine.tick();
    expect(engine.runningCount).toBe(2);
    expect((await getJob(idC)).status).toBe('queued');

    await vi.waitFor(() => {
      expect(gates.has('conc-a')).toBe(true);
      expect(gates.has('conc-b')).toBe(true);
    });
    // 释放一个空位后第三个才可被派发
    gates.get('conc-a')!.resolve();
    await vi.waitFor(() => {
      expect(engine.runningCount).toBe(1);
    });
    await engine.tick();
    expect(engine.runningCount).toBe(2);
    await vi.waitFor(() => {
      expect(gates.has('conc-c')).toBe(true);
    });

    gates.get('conc-b')!.resolve();
    gates.get('conc-c')!.resolve();
    await engine.idle();
    for (const id of [idA, idB, idC]) {
      expect((await getJob(id)).status).toBe('succeeded');
    }
  });

  it('start/stop 轮询循环可自动消化队列', async () => {
    const engine = new JobEngine(db);
    engine.registerHandler('stop', async () => {});
    const id = await engine.enqueue('stop', 'loop-a', undefined, 'root@example.com');
    engine.start(20);
    try {
      await vi.waitFor(async () => {
        expect((await getJob(id)).status).toBe('succeeded');
      });
    } finally {
      engine.stop();
    }
  });
});

describe('jobs 路由: 分页与权限', () => {
  let app: FastifyInstance;
  let ownerId: number;
  let otherId: number;
  let ownJob1: number;
  let ownJob2: number;
  let otherJob: number;
  let ghostJob: number;

  function asCtx(ctx: SessionCtxLike): Record<string, string> {
    return { 'x-test-ctx': JSON.stringify(ctx) };
  }
  const rootHeaders = (): Record<string, string> =>
    asCtx({ operatorId: 999, email: 'root@example.com', role: 'root' });
  const viewerHeaders = (): Record<string, string> =>
    asCtx({ operatorId: 998, email: 'viewer@example.com', role: 'viewer' });
  const ownerHeaders = (): Record<string, string> =>
    asCtx({ operatorId: ownerId, email: 'owner@example.com', role: 'operator' });

  async function seedJob(
    slug: string,
    payload?: Record<string, unknown>,
  ): Promise<number> {
    const rows = await db.orm
      .insert(jobs)
      .values({
        kind: 'provision',
        slug,
        createdBy: 'root@example.com',
        status: 'succeeded',
        ...(payload !== undefined ? { payload } : {}),
      })
      .returning({ id: jobs.id });
    return rows[0]!.id;
  }

  beforeAll(async () => {
    ownerId = await seedOperator(db, { email: 'owner@example.com', role: 'operator' });
    otherId = await seedOperator(db, { email: 'other@example.com', role: 'operator' });
    await db.orm.insert(sites).values([
      {
        operatorId: ownerId,
        slug: 'site-own',
        label: '自有站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18101,
        baseUrl: 'http://127.0.0.1:18101',
      },
      {
        operatorId: otherId,
        slug: 'site-other',
        label: '他人站',
        engine: 'newapi',
        version: 'v1.0.0',
        hostPort: 18102,
        baseUrl: 'http://127.0.0.1:18102',
      },
    ]);
    // 终态 job（afterEach 清理不触碰），含一条 payload 带敏感 key 的
    ownJob1 = await seedJob('site-own', { version: 'v1.0.0', apiKey: 'sk-test-payload-9999999999' });
    otherJob = await seedJob('site-other');
    ownJob2 = await seedJob('site-own');
    ghostJob = await seedJob('ghost-site'); // slug 不在 sites 的历史 job

    app = Fastify();
    // 模拟 server.ts 认证钩子：从测试头还原 req.ctx（F4 落地后由真钩子替代）
    app.addHook('onRequest', async (req) => {
      const raw = req.headers['x-test-ctx'];
      if (typeof raw === 'string') {
        (req as FastifyRequest & { ctx?: SessionCtxLike }).ctx = JSON.parse(raw) as SessionCtxLike;
      }
    });
    registerJobsRoutes(app, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('无 ctx → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(401);
    const res2 = await app.inject({ method: 'GET', url: `/api/jobs/${ownJob1}` });
    expect(res2.statusCode).toBe(401);
  });

  it('root 看全量（含 slug 不在 sites 的 job），按 id 倒序', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs?limit=200', headers: rootHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { jobs: JobRow[] };
    const ids = body.jobs.map((j) => j.id);
    for (const id of [ownJob1, ownJob2, otherJob, ghostJob]) {
      expect(ids).toContain(id);
    }
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('viewer 与 root 同等全量可见', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs?limit=200', headers: viewerHeaders() });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { jobs: JobRow[] }).jobs.map((j) => j.id);
    expect(ids).toContain(ghostJob);
    expect(ids).toContain(otherJob);
  });

  it('operator 只看 own 站的 job；他站与孤儿 slug 均不可见', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: ownerHeaders() });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { jobs: JobRow[] }).jobs.map((j) => j.id);
    expect(ids).toEqual([ownJob2, ownJob1]);
  });

  it('slug 过滤与 limit 生效（倒序取最新）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs?slug=site-own&limit=1',
      headers: rootHeaders(),
    });
    const ids = (res.json() as { jobs: JobRow[] }).jobs.map((j) => j.id);
    expect(ids).toEqual([ownJob2]);

    // operator 过滤他人站 slug → 空
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/jobs?slug=site-other',
      headers: ownerHeaders(),
    });
    expect((res2.json() as { jobs: JobRow[] }).jobs).toEqual([]);

    // 非法 limit 回落默认值，不报错
    const res3 = await app.inject({ method: 'GET', url: '/api/jobs?limit=abc', headers: rootHeaders() });
    expect(res3.statusCode).toBe(200);
  });

  it('列表与详情响应里 payload 的敏感 key 被打码', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/jobs?slug=site-own', headers: rootHeaders() });
    expect(list.body).not.toContain('sk-test-payload-9999999999');
    const row = (list.json() as { jobs: JobRow[] }).jobs.find((j) => j.id === ownJob1)!;
    expect(row.payload).toMatchObject({ version: 'v1.0.0', apiKey: '<redacted>' });

    const detail = await app.inject({ method: 'GET', url: `/api/jobs/${ownJob1}`, headers: rootHeaders() });
    expect(detail.body).not.toContain('sk-test-payload-9999999999');
    // DB 原文保持不动（handler 要用），只在 API 出口打码
    expect((await getJob(ownJob1)).payload).toMatchObject({ apiKey: 'sk-test-payload-9999999999' });
  });

  it('详情权限：own 可看，他站 403，孤儿 slug 对 operator 403，root 可看', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/jobs/${ownJob1}`, headers: ownerHeaders() });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { job: JobRow }).job.id).toBe(ownJob1);

    const forbidden = await app.inject({ method: 'GET', url: `/api/jobs/${otherJob}`, headers: ownerHeaders() });
    expect(forbidden.statusCode).toBe(403);

    const ghost = await app.inject({ method: 'GET', url: `/api/jobs/${ghostJob}`, headers: ownerHeaders() });
    expect(ghost.statusCode).toBe(403);

    const rootGhost = await app.inject({ method: 'GET', url: `/api/jobs/${ghostJob}`, headers: rootHeaders() });
    expect(rootGhost.statusCode).toBe(200);
  });

  it('详情：不存在 404，非法 id 400', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/jobs/999999', headers: rootHeaders() });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/jobs/abc', headers: rootHeaders() });
    expect(bad.statusCode).toBe(400);
  });
});
