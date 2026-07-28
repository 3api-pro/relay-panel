import { describe, expect, it } from 'vitest';
import type { SiteUpstreamWalletCandidate } from '../src/sites/service.js';
import {
  buildVendorView,
  normalizeVendorOrigin,
  resolveVendorSources,
  snapshotProbe,
  type VendorConfig,
} from '../src/upstream/vendors.js';

function candidate(
  siteSlug: string,
  baseUrl: string,
  balance = 20,
  observedAt = '2026-07-28T08:00:00.000Z',
): SiteUpstreamWalletCandidate {
  return {
    siteSlug,
    siteLabel: siteSlug.toUpperCase(),
    siteEngine: 'sub2api',
    accountId: '7',
    accountName: 'wallet-account',
    enabled: true,
    baseUrl,
    system: 'sub2api',
    discovery: 'server-snapshot',
    snapshot: {
      status: 'ok',
      protocol: 'sub2api_v1_usage',
      mode: 'unrestricted',
      balance,
      costMonthToDate: 7,
      costCoverage: 'exact',
      currency: 'USD',
      unit: 'USD',
      observedAt,
    },
  };
}

function manual(overrides: Partial<VendorConfig> = {}): VendorConfig {
  return {
    vendor: 'fuyao',
    label: '扶摇 CC Max',
    baseUrl: 'https://fuyao.shop',
    apiKey: 'test-only-not-a-real-key',
    system: 'sub2api',
    enabled: true,
    ...overrides,
  };
}

describe('供应商钱包自动发现与旧配置覆盖', () => {
  it('按公网 origin 折叠四站同源账号，并让 upstream:* 只覆盖展示字段', () => {
    const sources = resolveVendorSources(
      [manual({ balanceDivisor: 2 })],
      [
        candidate('sub', 'https://fuyao.shop/v1', 20),
        candidate('vip', 'https://FUYAO.shop/', 21, '2026-07-28T09:00:00.000Z'),
        candidate('tie', 'https://fuyao.shop/api', 20),
        candidate('iphy', 'https://fuyao.shop', 20),
      ],
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      discovery: 'automatic+override',
      system: 'sub2api',
      config: { vendor: 'fuyao', label: '扶摇 CC Max', balanceDivisor: 2 },
    });
    expect(sources[0]!.candidates).toHaveLength(4);
    expect(snapshotProbe(sources[0]!.candidates)).toMatchObject({
      probe: { balance: 21, costMonthToDate: 7, costCoverage: 'exact' },
      snapshotAt: '2026-07-28T09:00:00.000Z',
      system: 'sub2api',
    });
  });

  it('没有 upstream:* 也会创建稳定的自动供应商卡片', () => {
    const sources = resolveVendorSources([], [candidate('sub', 'https://api.mufeng0903.cloud/v1')]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      discovery: 'automatic',
      config: {
        vendor: 'auto-api-mufeng0903-cloud',
        label: 'mufeng0903.cloud',
        apiKey: '',
      },
    });
  });

  it('二跳清单使用供应商标签，并保留占位额度的明确原因', () => {
    const image = candidate('manifest:1:v3', 'https://api.image.example.com/v1');
    image.siteEngine = 'manifest';
    image.siteLabel = 'Image Supplier';
    image.accountId = 'image-supplier';
    image.accountName = 'image-supplier';
    image.system = 'newapi';
    image.snapshot = {
      status: 'unsupported',
      protocol: 'newapi_billing',
      costCoverage: 'none',
      observedAt: '2026-07-28T08:00:00.000Z',
      reasonCode: 'placeholder_limit',
    };

    const sources = resolveVendorSources([], [image]);
    expect(sources[0]?.config.label).toBe('Image Supplier');
    expect(snapshotProbe(sources[0]!.candidates).probe.reason).toContain('占位额度');
  });

  it('上一次成功值在刷新失败后保留 stale 标记', () => {
    const old = candidate('sub', 'https://stale.example.com');
    old.snapshot!.stale = true;
    const result = snapshotProbe([old]);
    expect(result.probe.balance).toBe(20);
    expect(result.stale).toBe(true);
  });

  it('同源 enabled:false 保留旧停用语义并隐藏自动卡片', () => {
    expect(resolveVendorSources(
      [manual({ enabled: false })],
      [candidate('sub', 'https://fuyao.shop/v1')],
    )).toEqual([]);
  });

  it('同名账号跨站成本只计一次，不同账号名按不同采购 key 汇总', () => {
    const first = candidate('sub', 'https://wallet.example.com', 30);
    const mirror = candidate('vip', 'https://wallet.example.com/v1', 30);
    const anotherKey = candidate('tie', 'https://wallet.example.com', 30);
    anotherKey.accountName = 'wallet-account-2';
    anotherKey.snapshot!.costMonthToDate = 4;
    expect(snapshotProbe([first, mirror, anotherKey]).probe).toMatchObject({
      balance: 30,
      costMonthToDate: 11,
      costCoverage: 'exact',
    });
  });

  it('自动来源拒绝 HTTP 和私网 relay，手工兼容项仍独立保留', () => {
    const privateCandidate = candidate('sub', 'https://127.0.0.1:3232');
    const httpCandidate = candidate('sub', 'http://example.com');
    const sources = resolveVendorSources([manual()], [privateCandidate, httpCandidate]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.discovery).toBe('manual');
  });

  it('quota remaining 不冒充钱包余额，成本 partial 与来源元数据原样进入视图', () => {
    const c = candidate('sub', 'https://quota.example.com');
    c.snapshot = {
      status: 'ok',
      protocol: 'sub2api_v1_usage',
      mode: 'quota_limited',
      remaining: 99,
      costMonthToDate: 3,
      costCoverage: 'partial',
      observedAt: '2026-07-28T10:00:00.000Z',
    };
    const auto = snapshotProbe([c]);
    expect(auto.probe).toMatchObject({ balance: null, costMonthToDate: 3, costCoverage: 'partial' });
    const view = buildVendorView(manual(), auto.probe, 3, new Date('2026-07-28T12:00:00Z'), {
      discovery: 'automatic',
      sourceCount: 1,
      snapshotAt: auto.snapshotAt,
      system: auto.system,
    });
    expect(view).toMatchObject({
      available: false,
      balance: null,
      costCoverage: 'partial',
      discovery: 'automatic',
      sourceCount: 1,
      snapshotAt: '2026-07-28T10:00:00.000Z',
    });
  });

  it('origin 规范化移除路径/query/fragment，拒绝 URL 内嵌凭据', () => {
    expect(normalizeVendorOrigin('https://Example.com:443/v1?q=1#x')).toBe('https://example.com');
    expect(normalizeVendorOrigin('https://user:pass@example.com')).toBeNull();
  });
});
