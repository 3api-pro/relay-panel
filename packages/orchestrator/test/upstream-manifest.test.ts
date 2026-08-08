import { describe, expect, it, vi } from 'vitest';
import { readTrustedUpstreamManifests } from '../src/upstream/manifest.js';
import { resolveVendorSources } from '../src/upstream/vendors.js';

function manifestWallet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: 'vendor-stable-id',
    label: 'Vendor Display Name',
    base_url: 'HTTPS://Vendor.Example.COM:443/api///?token=must-not-leak#private',
    protocol: 'sub2api_v1_usage',
    status: 'ok',
    balance: 42.5,
    cost_month_to_date: 10.25,
    cost_coverage: 'complete',
    probed_at: '2026-07-28T08:09:10.000Z',
    last_error: null,
    purposes: ['image'],
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

describe('受信任上游钱包清单', () => {
  it('仅映射白名单字段，并将 complete 映射为 exact', async () => {
    const secret = 'SECRET_MUST_NOT_LEAK';
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        schema_version: 1,
        api_key: secret,
        raw: { authorization: secret },
        wallets: [
          manifestWallet({ api_key: secret, token: secret, raw_response: secret }),
          manifestWallet({
            vendor: 'unsafe-userinfo',
            base_url: `https://user:${secret}@unsafe.example.com`,
          }),
        ],
      }),
    );

    const rows = await readTrustedUpstreamManifests(
      ['http://127.0.0.1:3230/internal/upstream-wallets'],
      { fetchFn: fetchMock as unknown as typeof fetch },
    );

    expect(rows).toEqual([
      {
        siteSlug: 'manifest:1:127-0-0-1',
        siteLabel: 'Vendor Display Name',
        siteEngine: 'manifest',
        accountId: 'vendor-stable-id',
        accountName: 'vendor-stable-id',
        enabled: true,
        baseUrl: 'https://vendor.example.com/api',
        system: 'sub2api',
        discovery: 'server-snapshot',
        purposes: ['image'],
        snapshot: {
          schemaVersion: 1,
          status: 'ok',
          protocol: 'sub2api_v1_usage',
          balance: 42.5,
          costMonthToDate: 10.25,
          costCoverage: 'exact',
          currency: 'USD',
          unit: 'USD',
          observedAt: '2026-07-28T08:09:10.000Z',
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toMatch(/api_key|raw_response|authorization|token/i);
    expect(resolveVendorSources([], rows)).toMatchObject([
      {
        discovery: 'automatic',
        config: {
          vendor: 'auto-vendor-example-com',
          label: 'Vendor Display Name',
          apiKey: '',
        },
      },
    ]);
  });

  it('根 schema 无效时丢弃来源，单条钱包字段或语义无效时只跳过该条', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ schema_version: 2, wallets: [manifestWallet()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 1,
          wallets: [
            manifestWallet({ vendor: 'bad\ncontrol' }),
            manifestWallet({ vendor: 'bad-status', status: 'failed', balance: 1 }),
            manifestWallet({ vendor: 'negative-cost', cost_month_to_date: -0.01 }),
            manifestWallet({ vendor: 'bad-error', last_error: 'Bearer secret text' }),
            manifestWallet({
              vendor: 'valid-failed',
              label: 'Valid failed probe',
              protocol: 'unknown',
              status: 'failed',
              balance: null,
              cost_month_to_date: null,
              cost_coverage: 'none',
              last_error: 'auth_failed',
            }),
          ],
        }),
      );

    const rows = await readTrustedUpstreamManifests(
      ['http://127.0.0.1:3230/one', 'http://localhost:3230/two'],
      { fetchFn: fetchMock as unknown as typeof fetch },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: 'valid-failed',
      siteLabel: 'Valid failed probe',
      system: 'unknown',
      snapshot: {
        status: 'failed',
        costCoverage: 'none',
        reasonCode: 'auth_failed',
      },
    });
    expect(rows[0]?.snapshot).not.toHaveProperty('balance');
    expect(rows[0]?.snapshot).not.toHaveProperty('costMonthToDate');
  });

  it('拒绝公网 HTTP，允许回环 HTTP', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ schema_version: 1, wallets: [manifestWallet()] }),
    );

    const rejected = await readTrustedUpstreamManifests(
      ['http://wallets.example.com/internal/upstream-wallets'],
      { fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(rejected).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const accepted = await readTrustedUpstreamManifests(
      ['http://[::1]:3230/internal/upstream-wallets'],
      { fetchFn: fetchMock as unknown as typeof fetch },
    );
    expect(accepted).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('公网 HTTPS 必须解析到公网地址，解析到私网时不发请求', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ schema_version: 1, wallets: [manifestWallet()] }),
    );

    const publicRows = await readTrustedUpstreamManifests(
      ['https://wallets.example.com/internal/upstream-wallets'],
      {
        fetchFn: fetchMock as unknown as typeof fetch,
        resolve: async () => ['93.184.216.34'],
      },
    );
    expect(publicRows).toHaveLength(1);

    const privateRows = await readTrustedUpstreamManifests(
      ['https://private.example.com/internal/upstream-wallets'],
      {
        fetchFn: fetchMock as unknown as typeof fetch,
        resolve: async () => ['10.0.0.5'],
      },
    );
    expect(privateRows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('force 仅追加查询参数，并固定手动重定向、JSON Accept 和超时信号', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return jsonResponse({ schema_version: 1, wallets: [manifestWallet()] });
    });

    const rows = await readTrustedUpstreamManifests(
      ['http://localhost:3230/internal/upstream-wallets?tenant=a#ignored'],
      { force: true, fetchFn: fetchMock as unknown as typeof fetch },
    );

    expect(rows).toHaveLength(1);
    const url = new URL(seenUrl);
    expect(url.searchParams.get('tenant')).toBe('a');
    expect(url.searchParams.get('force')).toBe('1');
    expect(url.hash).toBe('');
    expect(seenInit?.redirect).toBe('manual');
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
    expect(seenInit?.headers).toEqual({ Accept: 'application/json' });
    expect(JSON.stringify(seenInit?.headers)).not.toMatch(/authorization|cookie|token|key/i);
  });

  it('逐来源隔离 3xx、声明超限和实际超限，保留健康来源', async () => {
    const tooLarge = 'x'.repeat(256 * 1024 + 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9999/secret' } }),
      )
      .mockResolvedValueOnce(
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(256 * 1024 + 1),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(tooLarge, { headers: { 'content-type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ schema_version: 1, wallets: [manifestWallet({ vendor: 'healthy' })] }),
      );

    const rows = await readTrustedUpstreamManifests(
      [
        'http://127.0.0.1:3230/redirect',
        'http://127.0.0.1:3230/declared-large',
        'http://127.0.0.1:3230/streamed-large',
        'http://127.0.0.1:3230/healthy',
      ],
      { fetchFn: fetchMock as unknown as typeof fetch },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe('healthy');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
