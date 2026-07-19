import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, jobs as jobsTable, sites } from '../src/db/schema.js';
import {
  clearSiteCaches,
  lifecycleStepSink,
  makeStoreCredential,
} from '../src/sites/service.js';
import { importTemplates } from '../src/marketplace/grant.js';
import { makeTestServer, type TestServer } from './helpers.js';
import type { FakeLifecycleOptions } from './fakes.js';

/**
 * 批量操作（POST /api/sites/batch）：多选站点扇出公告/品牌/渠道，逐站结果，
 * 尊重 readonly 保险丝 + operator 归属隔离；部分失败不影响其它站。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let opCookie: string;

function wireLifecycles(server: TestServer): void {
  const store = makeStoreCredential(server.db, server.config);
  for (const lc of [server.lifecycles.sub2api, server.lifecycles.newapi]) {
    const opts = (lc as unknown as { opts: FakeLifecycleOptions }).opts;
    opts.storeCredential = (slug, secrets) => store(slug, secrets);
    opts.onStep = (slug, step, status, detail) => lifecycleStepSink(slug, step, status, detail);
  }
}

async function drainJobs(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await ts.jobs.tick();
    await ts.jobs.idle();
    if (n === 0) break;
  }
}

async function provisionActive(cookie: string, slug: string): Promise<void> {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/sites',
    cookies: { rp_session: cookie },
    payload: { slug, label: slug, engine: 'sub2api', version: 'v1.2.3', adminEmail: 'admin@example.com' },
  });
  expect(res.statusCode, res.body).toBe(201);
  await drainJobs();
}

async function batch(cookie: string, body: Record<string, unknown>) {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/sites/batch',
    cookies: { rp_session: cookie },
    payload: body,
  });
  return { status: res.statusCode, json: res.json() as { total: number; ok: number; failed: number; results: Array<{ slug: string; ok: boolean; error?: string; detail?: string }> } };
}

interface PreviewItem { kind: string; target: string; field?: string; from?: string; to?: string; flag?: string }
interface PreviewResult { slug: string; ok: boolean; blocked?: boolean; preview?: PreviewItem[]; error?: string }

/** 干跑：自动附加 dryRun:true，返回预览形状响应 */
async function dryBatch(cookie: string, body: Record<string, unknown>) {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/sites/batch',
    cookies: { rp_session: cookie },
    payload: { ...body, dryRun: true },
  });
  return {
    status: res.statusCode,
    body: res.body,
    json: res.json() as { dryRun: boolean; total: number; ok: number; failed: number; results: PreviewResult[] },
  };
}

async function countRows(table: typeof auditEvents | typeof jobsTable): Promise<number> {
  return (await ts.db.orm.select().from(table)).length;
}

beforeAll(async () => {
  clearSiteCaches();
  ts = await makeTestServer({ config: { portRange: { min: 18300, max: 18310 } } });
  wireLifecycles(ts);
  rootCookie = (await ts.seedLogin({ email: 'batch-root@example.com', password: 'root-pass-1234', role: 'root' })).cookie;
  opCookie = (await ts.seedLogin({ email: 'batch-op@example.com', password: 'op-pass-1234', role: 'operator' })).cookie;
  for (const slug of ['b-a', 'b-b', 'b-c']) await provisionActive(rootCookie, slug);
}, 90_000);

afterAll(async () => {
  await ts.close();
});

describe('批量公告/品牌', () => {
  it('三站批量设公告，逐站 ok，引擎状态生效', async () => {
    const { status, json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-b', 'b-c'],
      announcement: '统一维护公告 2026-07-18',
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(3);
    expect(json.failed).toBe(0);
    for (const slug of ['b-a', 'b-b', 'b-c']) {
      expect(ts.adapters.sub2api.stateFor(slug).branding.announcement).toBe('统一维护公告 2026-07-18');
    }
  });

  it('批量改品牌名', async () => {
    const { json } = await batch(rootCookie, {
      kind: 'branding',
      slugs: ['b-a', 'b-b'],
      siteName: '统一品牌名',
    });
    expect(json.ok).toBe(2);
    expect(ts.adapters.sub2api.stateFor('b-a').branding.siteName).toBe('统一品牌名');
    expect(ts.adapters.sub2api.stateFor('b-b').branding.siteName).toBe('统一品牌名');
  });

  it('去重：重复 slug 只执行一次', async () => {
    const { json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-a', 'b-a'],
      announcement: 'dedup',
    });
    expect(json.total).toBe(1);
    expect(json.ok).toBe(1);
  });
});

describe('批量建渠道 + 启停', () => {
  it('批量建渠道后按名批量停用', async () => {
    const create = await batch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a', 'b-b'],
      channel: { name: 'batch-up', protocol: 'openai', baseUrl: 'https://up.example.com', apiKey: 'sk-x', models: ['m1'] },
    });
    expect(create.ok ?? create.json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      expect(ts.adapters.sub2api.stateFor(slug).channels.some((c) => c.name === 'batch-up' && c.enabled)).toBe(true);
    }

    const toggle = await batch(rootCookie, {
      kind: 'channel.toggle',
      slugs: ['b-a', 'b-b'],
      channelName: 'batch-up',
      enabled: false,
    });
    expect(toggle.json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      expect(ts.adapters.sub2api.stateFor(slug).channels.find((c) => c.name === 'batch-up')!.enabled).toBe(false);
    }
  });

  it('渠道名不存在的站返回逐站 error，不拖垮其它站', async () => {
    // b-c 没有 batch-up 渠道；b-a 有
    const { json } = await batch(rootCookie, {
      kind: 'channel.toggle',
      slugs: ['b-a', 'b-c'],
      channelName: 'batch-up',
      enabled: true,
    });
    expect(json.total).toBe(2);
    expect(json.ok).toBe(1);
    expect(json.failed).toBe(1);
    const bc = json.results.find((r) => r.slug === 'b-c')!;
    expect(bc.ok).toBe(false);
    expect(bc.error).toContain('未找到');
  });
});

describe('批量渠道更新 / 删除', () => {
  it('批量按名更新渠道（轮换 key / 改模型）', async () => {
    await batch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a', 'b-b'],
      channel: { name: 'up-rotate', protocol: 'openai', baseUrl: 'https://old.example.com', apiKey: 'sk-old', models: ['m1'] },
    });
    const { json } = await batch(rootCookie, {
      kind: 'channel.update',
      slugs: ['b-a', 'b-b'],
      channelName: 'up-rotate',
      patch: { baseUrl: 'https://new.example.com', apiKey: 'sk-new', models: ['m1', 'm2'] },
    });
    expect(json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      const c = ts.adapters.sub2api.stateFor(slug).channels.find((x) => x.name === 'up-rotate')!;
      expect(c.baseUrl).toBe('https://new.example.com');
      expect(c.models).toEqual(['m1', 'm2']);
    }
  });

  it('批量按名删除渠道', async () => {
    const { json } = await batch(rootCookie, {
      kind: 'channel.delete',
      slugs: ['b-a', 'b-b'],
      channelName: 'up-rotate',
    });
    expect(json.ok).toBe(2);
    for (const slug of ['b-a', 'b-b']) {
      expect(ts.adapters.sub2api.stateFor(slug).channels.some((c) => c.name === 'up-rotate')).toBe(false);
    }
  });
});

describe('跨站渠道矩阵', () => {
  it('矩阵反映每站 enabled/disabled/absent', async () => {
    // b-a 有 mx-ch(启用)，b-b 有 mx-ch(停用)，b-c 无
    await batch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a', 'b-b'],
      channel: { name: 'mx-ch', protocol: 'openai', baseUrl: 'https://mx.example.com', apiKey: 'sk-mx', models: ['m1'] },
    });
    await batch(rootCookie, { kind: 'channel.toggle', slugs: ['b-b'], channelName: 'mx-ch', enabled: false });

    const res = await ts.app.inject({ method: 'GET', url: '/api/sites/channel-matrix', cookies: { rp_session: rootCookie } });
    const m = res.json() as { sites: Array<{ slug: string }>; channels: Array<{ name: string; presence: Record<string, string> }> };
    const row = m.channels.find((c) => c.name === 'mx-ch')!;
    expect(row.presence['b-a']).toBe('enabled');
    expect(row.presence['b-b']).toBe('disabled');
    expect(row.presence['b-c']).toBe('absent');
  });
});

describe('权限与只读保险丝', () => {
  it('readonly 站在批量里返回 403 error，其它站照常', async () => {
    await ts.db.orm.update(sites).set({ readonly: true }).where(eq(sites.slug, 'b-c'));
    const { json } = await batch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-c'],
      announcement: 'readonly-test',
    });
    expect(json.ok).toBe(1);
    const bc = json.results.find((r) => r.slug === 'b-c')!;
    expect(bc.ok).toBe(false);
    expect(bc.error).toContain('只读');
    await ts.db.orm.update(sites).set({ readonly: false }).where(eq(sites.slug, 'b-c'));
  });

  it('operator 只能批量操作自己名下的站；他人站计为 error(站点不存在)', async () => {
    // op 名下建一个站（free 配额 1）
    await provisionActive(opCookie, 'op-own');
    const { json } = await batch(opCookie, {
      kind: 'announcement',
      slugs: ['op-own', 'b-a'], // b-a 属于 root
      announcement: 'op-scope',
    });
    expect(json.ok).toBe(1);
    const foreign = json.results.find((r) => r.slug === 'b-a')!;
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain('站点不存在');
  });

  it('viewer 批量写被拒（每站 403）', async () => {
    const viewer = await ts.seedLogin({ email: 'batch-viewer@example.com', password: 'v-pass-1234', role: 'viewer' });
    const { json } = await batch(viewer.cookie, {
      kind: 'announcement',
      slugs: ['b-a'],
      announcement: 'nope',
    });
    expect(json.ok).toBe(0);
    expect(json.results[0]!.error).toContain('只读');
  });

  it('空 slugs → 400', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      cookies: { rp_session: rootCookie },
      payload: { kind: 'announcement', slugs: [], announcement: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('批量干跑预览 (dryRun)', () => {
  beforeAll(async () => {
    // 已知基线：b-a/b-b 各建 dry-ch(启用)；b-a 站名/公告设为已知值；供 grant 预览的 byo 模板
    await batch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a', 'b-b'],
      channel: { name: 'dry-ch', protocol: 'openai', baseUrl: 'https://old.example.com', apiKey: 'sk-old', models: ['m1'] },
    });
    await batch(rootCookie, { kind: 'branding', slugs: ['b-a'], siteName: '干跑品牌' });
    await batch(rootCookie, { kind: 'announcement', slugs: ['b-a'], announcement: '旧公告' });
    await importTemplates(ts.db, [
      { key: 'dry-tpl', title: 'Dry 模板', protocol: 'openai', models: ['m1', 'm2'], source: 'byo' },
    ]);
  });

  it('公告 dryRun：no-op 检测 + 字段 diff；零写零审计，响应带 dryRun', async () => {
    const beforeAudit = await countRows(auditEvents);
    const { status, json } = await dryBatch(rootCookie, {
      kind: 'announcement',
      slugs: ['b-a', 'b-b'],
      announcement: '旧公告',
    });
    expect(status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.total).toBe(2);
    const a = json.results.find((r) => r.slug === 'b-a')!;
    expect(a.ok).toBe(true);
    expect(a.preview![0]).toMatchObject({ field: 'announcement', from: '旧公告', to: '旧公告', flag: 'noop' });
    const b = json.results.find((r) => r.slug === 'b-b')!;
    // b-b 现公告与提议不同 → 变更（无 noop），且 from/to 均据实回显
    expect(b.preview![0].to).toBe('旧公告');
    expect(b.preview![0].from).not.toBe('旧公告');
    expect(b.preview![0].flag).toBeUndefined();
    // 零写：b-b 引擎公告未被改成“旧公告”、审计未新增
    expect(ts.adapters.sub2api.stateFor('b-b').branding.announcement).not.toBe('旧公告');
    expect(await countRows(auditEvents)).toBe(beforeAudit);
  });

  it('品牌 dryRun：仅提供的字段出现，值相同标 noop', async () => {
    const { json } = await dryBatch(rootCookie, {
      kind: 'branding',
      slugs: ['b-a'],
      siteName: '干跑品牌',
      logoUrl: 'https://x/logo.png',
    });
    const byField = Object.fromEntries(json.results[0]!.preview!.map((p) => [p.field, p]));
    expect(byField.siteName!.flag).toBe('noop');
    expect(byField.logoUrl!.to).toBe('https://x/logo.png');
    expect(byField.logoUrl!.flag).toBeUndefined();
    expect(byField.announcement).toBeUndefined(); // 未提供的字段不出现
  });

  it('建渠道 dryRun：同名冲突标 conflict，新名无 flag，apiKey 绝不进响应', async () => {
    const { json } = await dryBatch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a'],
      channel: { name: 'dry-ch', protocol: 'openai', baseUrl: 'https://n.example.com', apiKey: 'sk-secret-create', models: ['m1'] },
    });
    expect(json.results[0]!.preview![0]!.flag).toBe('conflict'); // dry-ch 已存在
    const { json: j2, body } = await dryBatch(rootCookie, {
      kind: 'channel.create',
      slugs: ['b-a'],
      channel: { name: 'brand-new-ch', protocol: 'openai', baseUrl: 'https://n.example.com', apiKey: 'sk-secret-create', models: ['m1'] },
    });
    expect(j2.results[0]!.preview![0]!.flag).toBeUndefined();
    expect(j2.results[0]!.preview![0]!.to).toContain('openai');
    expect(body).not.toContain('sk-secret-create');
    // 零写：新渠道未真的建
    expect(ts.adapters.sub2api.stateFor('b-a').channels.some((c) => c.name === 'brand-new-ch')).toBe(false);
  });

  it('改渠道 dryRun：字段 old→new + apiKey 仅标轮换不回显 + 未命中 miss', async () => {
    const { json, body } = await dryBatch(rootCookie, {
      kind: 'channel.update',
      slugs: ['b-a'],
      channelName: 'dry-ch',
      patch: { baseUrl: 'https://new.example.com', apiKey: 'sk-secret-rotate', models: ['m1', 'm2'] },
    });
    const items = json.results[0]!.preview!;
    const base = items.find((i) => i.field === 'baseUrl')!;
    expect(base).toMatchObject({ from: 'https://old.example.com', to: 'https://new.example.com' });
    const key = items.find((i) => i.field === 'apiKey')!;
    expect(key.from).toBeUndefined();
    expect(key.to).toBeUndefined(); // apiKey 绝不回显（仅以 field 标注将轮换）
    expect(items.find((i) => i.field === 'models')!.to).toBe('m1, m2');
    expect(body).not.toContain('sk-secret-rotate');
    // 未命中站标 miss
    const { json: miss } = await dryBatch(rootCookie, {
      kind: 'channel.update',
      slugs: ['b-c'],
      channelName: 'nope-ch',
      patch: { baseUrl: 'https://n.example.com' },
    });
    expect(miss.results[0]!.preview![0]!.flag).toBe('miss');
  });

  it('删渠道 dryRun：列出将删渠道；未命中 miss；零写', async () => {
    const { json } = await dryBatch(rootCookie, {
      kind: 'channel.delete',
      slugs: ['b-a', 'b-c'],
      channelName: 'dry-ch',
    });
    const a = json.results.find((r) => r.slug === 'b-a')!;
    expect(a.preview![0]!.kind).toBe('channel.delete');
    expect(a.preview![0]!.flag).toBeUndefined();
    const c = json.results.find((r) => r.slug === 'b-c')!;
    expect(c.preview![0]!.flag).toBe('miss');
    // 零写：dry-ch 仍在 b-a
    expect(ts.adapters.sub2api.stateFor('b-a').channels.some((x) => x.name === 'dry-ch')).toBe(true);
  });

  it('启停 dryRun：目标态相同标 noop，不同则 from→to', async () => {
    const { json } = await dryBatch(rootCookie, { kind: 'channel.toggle', slugs: ['b-a'], channelName: 'dry-ch', enabled: true });
    expect(json.results[0]!.preview![0]!.flag).toBe('noop'); // dry-ch 已启用
    const { json: j2 } = await dryBatch(rootCookie, { kind: 'channel.toggle', slugs: ['b-a'], channelName: 'dry-ch', enabled: false });
    expect(j2.results[0]!.preview![0]).toMatchObject({ from: 'enabled', to: 'disabled' });
    expect(j2.results[0]!.preview![0]!.flag).toBeUndefined();
  });

  it('市场授权 dryRun：模板落地渠道摘要 + 同名冲突；apiKey/授权均不落', async () => {
    const { json } = await dryBatch(rootCookie, {
      kind: 'grant',
      slugs: ['b-b'],
      templateKey: 'dry-tpl',
      channelName: '新授权渠道',
      byo: { baseUrl: 'https://up.example.com', apiKey: 'sk-secret-grant' },
    });
    const p = json.results[0]!.preview![0]!;
    expect(p.kind).toBe('grant');
    expect(p.target).toBe('新授权渠道');
    expect(p.to).toContain('m1, m2');
    expect(p.flag).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain('sk-secret-grant');
    // 同名冲突：channelName=dry-ch 已存在于 b-b
    const { json: j2 } = await dryBatch(rootCookie, {
      kind: 'grant',
      slugs: ['b-b'],
      templateKey: 'dry-tpl',
      channelName: 'dry-ch',
      byo: { baseUrl: 'https://up.example.com', apiKey: 'sk-x' },
    });
    expect(j2.results[0]!.preview![0]!.flag).toBe('conflict');
    // 零写：b-b 未新增 '新授权渠道'
    expect(ts.adapters.sub2api.stateFor('b-b').channels.some((c) => c.name === '新授权渠道')).toBe(false);
  });

  it('生命周期 dryRun：当前态 vs 目标；no-op 与 external skip；不建任务', async () => {
    const beforeJobs = await countRows(jobsTable);
    // b-a active + version v1.2.3
    const { json: start } = await dryBatch(rootCookie, { kind: 'lifecycle', slugs: ['b-a'], op: 'start' });
    expect(start.results[0]!.preview![0]!.flag).toBe('noop'); // 已 active
    const { json: upSame } = await dryBatch(rootCookie, { kind: 'lifecycle', slugs: ['b-a'], op: 'upgrade', toVersion: 'v1.2.3' });
    expect(upSame.results[0]!.preview![0]!.flag).toBe('noop');
    const { json: upDiff } = await dryBatch(rootCookie, { kind: 'lifecycle', slugs: ['b-a'], op: 'upgrade', toVersion: 'v2.0.0' });
    expect(upDiff.results[0]!.preview![0]).toMatchObject({ from: 'v1.2.3', to: 'v2.0.0' });
    expect(upDiff.results[0]!.preview![0]!.flag).toBeUndefined();
    // external 站：生命周期不适用 → skip
    await ts.db.orm.update(sites).set({ managed: 'external' }).where(eq(sites.slug, 'b-c'));
    const { json: ext } = await dryBatch(rootCookie, { kind: 'lifecycle', slugs: ['b-c'], op: 'start' });
    expect(ext.results[0]!.preview![0]!.flag).toBe('skip');
    await ts.db.orm.update(sites).set({ managed: 'compose' }).where(eq(sites.slug, 'b-c'));
    // 不建任务
    expect(await countRows(jobsTable)).toBe(beforeJobs);
  });

  it('readonly 站 dryRun：整站标 blocked 但仍算出预览；lifecycle 不受 readonly 约束不标 blocked', async () => {
    await ts.db.orm.update(sites).set({ readonly: true }).where(eq(sites.slug, 'b-c'));
    const { json } = await dryBatch(rootCookie, { kind: 'announcement', slugs: ['b-c'], announcement: '只读预览' });
    const c = json.results[0]!;
    expect(c.ok).toBe(true);
    expect(c.blocked).toBe(true);
    expect(c.preview!.length).toBeGreaterThan(0);
    // lifecycle 走 job 入队路径，不受 readonly 保险丝约束 → 据实不标 blocked
    const { json: lc } = await dryBatch(rootCookie, { kind: 'lifecycle', slugs: ['b-c'], op: 'start' });
    expect(lc.results[0]!.blocked).toBeUndefined();
    await ts.db.orm.update(sites).set({ readonly: false }).where(eq(sites.slug, 'b-c'));
  });

  it('站不可达 dryRun：该站 error，其它站照常（partial）', async () => {
    ts.adapters.sub2api.setUnreachable('b-b');
    const { json } = await dryBatch(rootCookie, { kind: 'announcement', slugs: ['b-a', 'b-b'], announcement: '旧公告' });
    expect(json.total).toBe(2);
    expect(json.ok).toBe(1);
    expect(json.failed).toBe(1);
    expect(json.results.find((r) => r.slug === 'b-a')!.ok).toBe(true);
    const b = json.results.find((r) => r.slug === 'b-b')!;
    expect(b.ok).toBe(false);
    expect(b.error).toContain('连接失败');
    ts.adapters.sub2api.setUnreachable('b-b', false);
  });

  it('operator dryRun 只见自己站；他人站 error 站点不存在', async () => {
    const { json } = await dryBatch(opCookie, { kind: 'announcement', slugs: ['op-own', 'b-a'], announcement: 'x' });
    expect(json.results.find((r) => r.slug === 'op-own')!.ok).toBe(true);
    const foreign = json.results.find((r) => r.slug === 'b-a')!;
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain('站点不存在');
  });

  it('空 slugs dryRun → 400', async () => {
    const res = await ts.app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      cookies: { rp_session: rootCookie },
      payload: { kind: 'announcement', slugs: [], announcement: 'x', dryRun: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
