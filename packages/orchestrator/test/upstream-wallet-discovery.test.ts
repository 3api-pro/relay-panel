import { describe, expect, it, vi } from 'vitest';
import type {
  EngineAdapter,
  EngineKind,
  EngineLifecycle,
  InstanceInfo,
  UpstreamWalletCandidate,
} from '@relay-panel/adapter-core';
import { Sub2apiAdminClient } from '../../adapter-sub2api/src/adapter.js';
import { NewapiAdminClient } from '../../adapter-newapi/src/adapter.js';
import { sites } from '../src/db/schema.js';
import { JobEngine } from '../src/jobs/engine.js';
import { SitesService } from '../src/sites/service.js';
import { FakeAdapter, FakeLifecycle } from './fakes.js';
import { makeTestConfig, makeTestDb, seedOperator } from './helpers.js';

// pglite 全量迁移在共享测试机上可能超过 vitest 默认 5s。
vi.setConfig({ testTimeout: 30_000 });

function inst(engine: EngineKind, slug = `wallet-${engine}`): InstanceInfo {
  return {
    siteSlug: slug,
    engine,
    version: 'test',
    baseUrl: 'http://127.0.0.1:3000',
    dataDir: '',
    composeProject: '',
    credentialRef: '',
  };
}

describe('Sub2API 上游钱包候选', () => {
  it('优先解析顶层快照、兼容 extra fallback，并且绝不带出密钥/raw/错误正文', async () => {
    const secret = 'SECRET_DO_NOT_LEAK';
    const accounts = [
      {
        id: 1,
        name: 'primary',
        platform: 'anthropic',
        type: 'apikey',
        status: 'active',
        credentials: {
          api_key: secret,
          base_url: `HTTPS://Vendor.Example.COM:443/api///?access_token=${secret}#fragment`,
        },
        upstream_wallet: {
          schema_version: 1,
          status: 'ok',
          protocol: 'sub2api_v1_usage',
          mode: 'unrestricted',
          balance: 12.5,
          cost_month_to_date: 3.25,
          cost_coverage: 'partial',
          stale: true,
          currency: 'USD',
          unit: 'USD',
          probed_at: '2026-07-28T01:02:03.000Z',
          fresh_until: '2026-07-28T01:07:03.000Z',
          next_probe_at: '2026-07-28T01:08:03.000Z',
          failure_count: 0,
          http_status: 200,
          last_error: `Bearer ${secret}`,
          raw_response: { token: secret },
        },
      },
      {
        id: 2,
        name: 'fallback',
        platform: 'openai',
        type: 'apikey',
        status: 'active',
        credentials: { api_key: secret, base_url: 'https://new.example.com/' },
        extra: {
          upstream_wallet_probe: {
            schema_version: 1,
            status: 'failed',
            protocol: 'newapi_billing',
            cost_coverage: 'none',
            probed_at: '2026-07-28T02:00:00Z',
            next_probe_at: '2026-07-28T02:05:00Z',
            failure_count: 2,
            http_status: 401,
            last_error: 'auth_failed',
          },
          api_key: secret,
        },
      },
      {
        id: 3,
        name: 'disabled',
        platform: 'openai',
        type: 'apikey',
        status: 'inactive',
        credentials: { api_key: secret, base_url: 'https://disabled.example.com' },
      },
      {
        id: 4,
        name: 'userinfo',
        platform: 'openai',
        type: 'apikey',
        status: 'active',
        credentials: { base_url: `https://user:${secret}@unsafe.example.com` },
      },
      {
        id: 5,
        name: 'bad-protocol',
        platform: 'openai',
        type: 'apikey',
        status: 'active',
        credentials: { base_url: 'file:///etc/passwd' },
      },
      {
        id: 6,
        name: 'quota-limited',
        platform: 'openai',
        type: 'apikey',
        status: 'active',
        credentials: { base_url: 'https://quota.example.com' },
        upstream_wallet: {
          status: 'ok',
          protocol: 'sub2api_v1_usage',
          mode: 'quota_limited',
          balance: 999_999,
          remaining: 7,
          probed_at: '2026-07-28T02:30:00Z',
          next_probe_at: '2026-07-28T02:35:00Z',
        },
      },
    ];
    const http = {
      listAll: vi.fn().mockResolvedValue(accounts),
      post: vi.fn(),
    };
    const client = new Sub2apiAdminClient(inst('sub2api'), http as never);

    const rows = await client.stats.upstreamWalletCandidates();

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      accountId: '1',
      accountName: 'primary',
      enabled: true,
      baseUrl: 'https://vendor.example.com/api',
      system: 'sub2api',
      discovery: 'server-snapshot',
      snapshot: {
        schemaVersion: 1,
        status: 'ok',
        protocol: 'sub2api_v1_usage',
        mode: 'unrestricted',
        balance: 12.5,
        costMonthToDate: 3.25,
        costCoverage: 'partial',
        stale: true,
        currency: 'USD',
        unit: 'USD',
        observedAt: '2026-07-28T01:02:03.000Z',
        freshUntil: '2026-07-28T01:07:03.000Z',
        nextProbeAt: '2026-07-28T01:08:03.000Z',
        failureCount: 0,
        httpStatus: 200,
      },
    });
    expect(rows[1]).toMatchObject({
      accountId: '2',
      baseUrl: 'https://new.example.com',
      system: 'newapi',
      discovery: 'server-snapshot',
      snapshot: {
        status: 'failed',
        protocol: 'newapi_billing',
        reasonCode: 'auth_failed',
      },
    });
    expect(rows[2]?.snapshot).toMatchObject({ mode: 'quota_limited', remaining: 7 });
    expect(rows[2]?.snapshot?.balance).toBeUndefined();
    expect(http.post).not.toHaveBeenCalled();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/api_key|access_token|credentials|raw_response/i);
  });

  it('force 按最多 20 个启用 apikey 分批探测，然后回读权威 accounts 快照', async () => {
    const apikeys = Array.from({ length: 41 }, (_, i) => ({
      id: i + 1,
      name: `account-${i + 1}`,
      platform: 'openai',
      type: 'apikey',
      status: 'active',
      credentials: { base_url: `https://vendor-${i + 1}.example.com/` },
    }));
    const accounts = [
      ...apikeys,
      {
        id: 100,
        name: 'oauth-not-probed',
        platform: 'anthropic',
        type: 'oauth',
        status: 'active',
        credentials: { base_url: 'https://oauth.example.com/' },
      },
    ];
    const refreshed = accounts.map((account, i) =>
      i === 0
        ? {
            ...account,
            upstream_wallet: {
              schema_version: 1,
              status: 'ok',
              protocol: 'sub2api_v1_usage',
              balance: 8,
              probed_at: '2026-07-28T03:00:00Z',
              next_probe_at: '2026-07-28T03:05:00Z',
            },
          }
        : account,
    );
    const http = {
      listAll: vi.fn().mockResolvedValueOnce(accounts).mockResolvedValueOnce(refreshed),
      post: vi.fn().mockResolvedValue({ results: [] }),
    };
    const client = new Sub2apiAdminClient(inst('sub2api'), http as never);

    const rows = await client.stats.upstreamWalletCandidates({ force: true });

    expect(http.post).toHaveBeenCalledTimes(3);
    expect(http.post.mock.calls.map((call) => call[1].account_ids.length)).toEqual([20, 20, 1]);
    expect(http.post.mock.calls[0]?.[0]).toBe('/api/v1/admin/accounts/upstream-wallet-probe/batch');
    expect(http.listAll).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(42);
    expect(rows[0]?.snapshot?.balance).toBe(8);
  });

  it('旧引擎批量端点失败时优雅降级为已有 metadata，不打挂整站', async () => {
    const accounts = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `legacy-${i + 1}`,
      platform: 'openai',
      type: 'apikey',
      status: 'active',
      credentials: { base_url: `https://legacy-${i + 1}.example.com` },
    }));
    const http = {
      listAll: vi.fn().mockResolvedValue(accounts),
      post: vi.fn().mockRejectedValue(new Error('HTTP 404')),
    };
    const client = new Sub2apiAdminClient(inst('sub2api'), http as never);

    const rows = await client.stats.upstreamWalletCandidates({ force: true });

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.listAll).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(25);
    expect(rows.every((row) => row.discovery === 'metadata-only')).toBe(true);
  });
});

describe('NewAPI 上游钱包候选', () => {
  it('仅返回启用且地址可靠的 metadata-only 候选，不误用站点管理凭据', async () => {
    const secret = 'NEWAPI_SECRET_DO_NOT_LEAK';
    const http = {
      listAll: vi.fn().mockResolvedValue([
        { id: 1, name: 'active', type: 1, status: 1, base_url: `https://UP.example.com/v1/?key=${secret}` },
        { id: 2, name: 'disabled', type: 1, status: 2, base_url: 'https://disabled.example.com' },
        { id: 3, name: 'userinfo', type: 1, status: 1, base_url: `https://user:${secret}@unsafe.example.com` },
      ]),
    };
    const client = new NewapiAdminClient(inst('newapi'), http as never);

    const rows = await client.stats.upstreamWalletCandidates({ force: true });

    expect(rows).toEqual([
      {
        accountId: '1',
        accountName: 'active',
        enabled: true,
        baseUrl: 'https://up.example.com/v1',
        system: 'unknown',
        discovery: 'metadata-only',
        snapshot: {
          status: 'unsupported',
          protocol: 'unknown',
          reasonCode: 'credential_not_exported',
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

describe('SitesService 上游钱包候选聚合', () => {
  it('覆盖 external + compose，保留站点/账号来源，透传 force，并隔离无权站与运行时额外字段', async () => {
    const db = await makeTestDb();
    try {
      const ownId = await seedOperator(db, { email: 'owner@example.com', role: 'operator' });
      const foreignId = await seedOperator(db, { email: 'foreign@example.com', role: 'operator' });
      await db.orm.insert(sites).values([
        {
          operatorId: ownId,
          slug: 'managed-external',
          label: 'External',
          engine: 'sub2api',
          version: 'v1',
          hostPort: 23001,
          baseUrl: 'http://127.0.0.1:23001',
          managed: 'external',
          status: 'active',
        },
        {
          operatorId: ownId,
          slug: 'managed-compose',
          label: 'Compose',
          engine: 'newapi',
          version: 'v1',
          hostPort: 23002,
          baseUrl: 'http://127.0.0.1:23002',
          managed: 'compose',
          status: 'active',
        },
        {
          operatorId: ownId,
          slug: 'managed-down',
          label: 'Down',
          engine: 'sub2api',
          version: 'v1',
          hostPort: 23003,
          baseUrl: 'http://127.0.0.1:23003',
          managed: 'external',
          status: 'active',
        },
        {
          operatorId: ownId,
          slug: 'managed-destroyed',
          label: 'Destroyed',
          engine: 'sub2api',
          version: 'v1',
          hostPort: 23004,
          baseUrl: 'http://127.0.0.1:23004',
          managed: 'external',
          status: 'destroyed',
        },
        {
          operatorId: foreignId,
          slug: 'foreign-site',
          label: 'Foreign',
          engine: 'sub2api',
          version: 'v1',
          hostPort: 23005,
          baseUrl: 'http://127.0.0.1:23005',
          managed: 'external',
          status: 'active',
        },
      ]);

      const adapters = {
        sub2api: new FakeAdapter('sub2api'),
        newapi: new FakeAdapter('newapi'),
      };
      const lifecycles = {
        sub2api: new FakeLifecycle('sub2api'),
        newapi: new FakeLifecycle('newapi'),
      };
      const tainted = {
        accountId: '11',
        accountName: 'source-account',
        enabled: true,
        baseUrl: 'https://wallet.example.com',
        system: 'sub2api',
        discovery: 'server-snapshot',
        snapshot: {
          status: 'ok',
          protocol: 'sub2api_v1_usage',
          balance: 10,
          token: 'RUNTIME_SECRET',
        },
        apiKey: 'RUNTIME_SECRET',
        raw: { credentials: 'RUNTIME_SECRET' },
      } as unknown as UpstreamWalletCandidate;
      adapters.sub2api.setUpstreamWalletCandidates('managed-external', [tainted]);
      adapters.newapi.setUpstreamWalletCandidates('managed-compose', [
        {
          accountId: '22',
          accountName: 'compose-account',
          enabled: true,
          baseUrl: 'https://compose-up.example.com',
          system: 'unknown',
          discovery: 'metadata-only',
        },
      ]);
      adapters.sub2api.setUpstreamWalletCandidates('managed-destroyed', [tainted]);
      adapters.sub2api.setUpstreamWalletCandidates('foreign-site', [tainted]);
      adapters.sub2api.setUnreachable('managed-down');

      const service = new SitesService({
        config: makeTestConfig(),
        db,
        adapters: adapters as Record<EngineKind, EngineAdapter>,
        lifecycles: lifecycles as Record<EngineKind, EngineLifecycle>,
        jobs: new JobEngine(db),
      });
      const rows = await service.listUpstreamWalletCandidates(
        { operatorId: ownId, email: 'owner@example.com', role: 'operator' },
        { force: true },
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => `${row.siteSlug}:${row.accountId}`)).toEqual([
        'managed-external:11',
        'managed-compose:22',
      ]);
      expect(rows[0]).toMatchObject({
        siteSlug: 'managed-external',
        siteLabel: 'External',
        siteEngine: 'sub2api',
        accountId: '11',
        snapshot: { balance: 10 },
      });
      expect(adapters.sub2api.calls).toContain('stats.upstreamWalletCandidates.force:managed-external');
      expect(adapters.newapi.calls).toContain('stats.upstreamWalletCandidates.force:managed-compose');
      expect(adapters.sub2api.calls).not.toContain('connect:managed-destroyed');
      expect(adapters.sub2api.calls).not.toContain('connect:foreign-site');
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('RUNTIME_SECRET');
      expect(serialized).not.toMatch(/apiKey|credentials|raw|token/);
    } finally {
      await db.close();
    }
  });
});
