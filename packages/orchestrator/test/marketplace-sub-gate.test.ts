import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, channelGrants, sites, subscriptions } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';
import { makeTestServer, type TestServer } from './helpers.js';

/**
 * 开放注册前置闸 §1：managed 渠道授权订阅门槛。
 * 免费 operator 启用 managed → 403（且不触网关签发）；有有效订阅 → 放行；
 * root 豁免；byo 模板不受此限。
 */

vi.setConfig({ testTimeout: 30_000 });

let ts: TestServer;
let rootCookie: string;
let freeCookie: string;
let paidCookie: string;

async function createTemplate(cookie: string, fields: Record<string, unknown>): Promise<void> {
  const res = await ts.app.inject({
    method: 'POST',
    url: '/api/marketplace/templates',
    cookies: { rp_session: cookie },
    payload: { title: '模板', protocol: 'anthropic', models: ['m'], ...fields },
  });
  expect(res.statusCode, res.body).toBe(200);
}

function grant(cookie: string, body: Record<string, unknown>) {
  return ts.app.inject({
    method: 'POST',
    url: '/api/marketplace/grants',
    cookies: { rp_session: cookie },
    payload: body,
  });
}

beforeAll(async () => {
  ts = await makeTestServer();
  const root = await ts.seedLogin({ email: 'gate-root@example.com', password: 'root-pass-1234', role: 'root' });
  rootCookie = root.cookie;
  const free = await ts.seedLogin({ email: 'gate-free@example.com', password: 'op-pass-1234', role: 'operator' });
  freeCookie = free.cookie;
  const paid = await ts.seedLogin({ email: 'gate-paid@example.com', password: 'op-pass-1234', role: 'operator' });
  paidCookie = paid.cookie;

  // paid operator 有有效订阅；free operator 没有
  await ts.db.orm.insert(subscriptions).values({
    operatorId: paid.operatorId,
    planKey: 'pro',
    currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 30 * 86_400_000)),
  });

  await ts.db.orm.insert(sites).values([
    { operatorId: free.operatorId, slug: 'free-site', label: 'F', engine: 'sub2api', version: 'v1', hostPort: 19001, baseUrl: 'http://127.0.0.1:19001', status: 'active' },
    { operatorId: paid.operatorId, slug: 'paid-site', label: 'P', engine: 'sub2api', version: 'v1', hostPort: 19002, baseUrl: 'http://127.0.0.1:19002', status: 'active' },
    { operatorId: root.operatorId, slug: 'root-site', label: 'R', engine: 'sub2api', version: 'v1', hostPort: 19003, baseUrl: 'http://127.0.0.1:19003', status: 'active' },
  ]);

  await createTemplate(rootCookie, { key: 'gate-managed', title: '托管', source: 'managed', protocol: 'openai', models: ['gpt-4o'] });
  await createTemplate(rootCookie, { key: 'gate-byo', title: 'BYO', source: 'byo', models: ['claude-x'] });
}, 60_000);

afterAll(async () => {
  await ts.close();
});

describe('managed 授权订阅门槛', () => {
  it('免费 operator 启用 managed → 403，且不触网关签发、不落授权行', async () => {
    const res = await grant(freeCookie, { siteSlug: 'free-site', templateKey: 'gate-managed' });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { message: string }).message).toBe('启用托管渠道需有效订阅');

    // 门槛在网关签发之前：不应有 free-site 的签发记录
    expect(ts.gateway.issued.some((k) => k.siteSlug === 'free-site')).toBe(false);
    // 不落 channel_grants 行
    const site = (await ts.db.orm.select().from(sites).where(eq(sites.slug, 'free-site')))[0]!;
    expect(await ts.db.orm.select().from(channelGrants).where(eq(channelGrants.siteId, site.id))).toHaveLength(0);
    // 拒绝落审计（ok:false）
    const audits = await ts.db.orm.select().from(auditEvents).where(eq(auditEvents.siteId, site.id));
    expect(audits.some((a) => a.action === 'marketplace.grant' && !a.ok)).toBe(true);
  });

  it('有有效订阅的 operator 启用 managed → 放行', async () => {
    const res = await grant(paidCookie, { siteSlug: 'paid-site', templateKey: 'gate-managed' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { managed: boolean }).managed).toBe(true);
  });

  it('root 无订阅也放行 managed（自用/dogfood 豁免）', async () => {
    const res = await grant(rootCookie, { siteSlug: 'root-site', templateKey: 'gate-managed' });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { managed: boolean }).managed).toBe(true);
  });

  it('byo 模板不受订阅门槛限制（免费 operator 可启用）', async () => {
    const res = await grant(freeCookie, {
      siteSlug: 'free-site',
      templateKey: 'gate-byo',
      byo: { baseUrl: 'http://203.0.113.10', apiKey: 'sk-byo-1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { managed: boolean }).managed).toBe(false);
  });
});
