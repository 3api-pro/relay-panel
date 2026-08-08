import { isIP } from 'node:net';
import { z } from 'zod';
import { assertPublicUrl } from '../net/guard.js';
import type { SiteUpstreamWalletCandidate } from '../sites/service.js';

const MANIFEST_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_RESPONSE_BYTES = 256 * 1024;
const MAX_MANIFEST_WALLETS = 1_000;

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
    .transform((value) => value.trim())
    .refine((value) => value.length > 0);

const manifestEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  wallets: z.array(z.unknown()).max(MAX_MANIFEST_WALLETS),
});

const manifestWalletSchema = z
  .object({
    vendor: safeText(120),
    label: safeText(200),
    base_url: z.string().trim().min(1).max(2_000),
    protocol: z.enum(['sub2api_v1_usage', 'newapi_billing', 'unknown']),
    status: z.enum(['ok', 'unsupported', 'failed']),
    balance: z.number().finite().nullable(),
    cost_month_to_date: z.number().finite().nonnegative().nullable(),
    cost_coverage: z.enum(['complete', 'partial', 'none']),
    probed_at: z
      .string()
      .max(64)
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
          Number.isFinite(Date.parse(value)),
      ),
    last_error: z.union([z.null(), z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)]),
    purposes: z.array(z.enum(['image', 'gpt', 'claude', 'gemini', 'aws'])).max(10).optional(),
  })
  .superRefine((wallet, ctx) => {
    if (wallet.status === 'ok' && wallet.balance === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['balance'], message: 'ok requires balance' });
    }
    if (wallet.status !== 'ok' && wallet.balance !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['balance'], message: 'non-ok requires null balance' });
    }
    if (wallet.cost_coverage === 'none' && wallet.cost_month_to_date !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cost_month_to_date'],
        message: 'none coverage requires null cost',
      });
    }
    if (wallet.cost_coverage !== 'none' && wallet.cost_month_to_date === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cost_month_to_date'],
        message: 'covered cost requires a number',
      });
    }
  });

export interface TrustedUpstreamManifestOptions {
  force?: boolean;
  fetchFn?: typeof fetch;
  /** 仅供测试注入；生产默认使用系统 DNS。 */
  resolve?: (host: string) => Promise<string[]>;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).replace(/\.$/, '').toLowerCase();
  if (host === 'localhost') return true;

  const family = isIP(host);
  if (family === 4) return host.split('.', 1)[0] === '127';
  if (family !== 6) return false;
  if (host === '::1') return true;

  // WHATWG URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1。
  const mapped = host.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1]!, 16);
  return (high >> 8) === 127;
}

async function validateManifestEndpoint(
  rawUrl: string,
  resolve?: (host: string) => Promise<string[]>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid_manifest_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid_manifest_protocol');
  }
  if (url.username !== '' || url.password !== '') throw new Error('manifest_url_userinfo');

  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Error('manifest_http_requires_loopback');
  if (!loopback) {
    await assertPublicUrl(url.toString(), {
      failClosed: true,
      ...(resolve !== undefined ? { resolve } : {}),
    });
  }
  url.hash = '';
  return url;
}

function normalizeWalletBaseUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    url.search = '';
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path === '' || path === '/' ? '' : path}`;
  } catch {
    return null;
  }
}

function manifestSourceSlug(endpoint: URL, sourceIndex: number): string {
  const host = stripIpv6Brackets(endpoint.hostname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `manifest:${sourceIndex + 1}:${host || 'source'}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (
    mediaType !== 'application/json' &&
    !(mediaType.startsWith('application/') && mediaType.endsWith('+json'))
  ) {
    throw new Error('invalid_manifest_content_type');
  }

  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_RESPONSE_BYTES) {
      throw new Error('manifest_response_too_large');
    }
  }
  if (!response.body) throw new Error('empty_manifest_response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_MANIFEST_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('manifest_response_too_large');
    }
    chunks.push(part.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body).replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new Error('invalid_manifest_json');
  }
}

function mapManifestWallets(
  body: unknown,
  endpoint: URL,
  sourceIndex: number,
): SiteUpstreamWalletCandidate[] {
  const envelope = manifestEnvelopeSchema.safeParse(body);
  if (!envelope.success) return [];

  const rows: SiteUpstreamWalletCandidate[] = [];
  for (const rawWallet of envelope.data.wallets) {
    const parsed = manifestWalletSchema.safeParse(rawWallet);
    if (!parsed.success) continue;
    const wallet = parsed.data;
    const baseUrl = normalizeWalletBaseUrl(wallet.base_url);
    if (baseUrl === null) continue;

    rows.push({
      siteSlug: manifestSourceSlug(endpoint, sourceIndex),
      siteLabel: wallet.label,
      siteEngine: 'manifest',
      accountId: wallet.vendor,
      accountName: wallet.vendor,
      enabled: true,
      baseUrl,
      system:
        wallet.protocol === 'sub2api_v1_usage'
          ? 'sub2api'
          : wallet.protocol === 'newapi_billing'
            ? 'newapi'
            : 'unknown',
      discovery: 'server-snapshot',
      ...(wallet.purposes !== undefined ? { purposes: [...new Set(wallet.purposes)] } : {}),
      snapshot: {
        schemaVersion: 1,
        status: wallet.status,
        protocol: wallet.protocol,
        ...(wallet.balance !== null ? { balance: wallet.balance } : {}),
        ...(wallet.cost_month_to_date !== null
          ? { costMonthToDate: wallet.cost_month_to_date }
          : {}),
        costCoverage:
          wallet.cost_coverage === 'complete' ? 'exact' : wallet.cost_coverage,
        currency: 'USD',
        unit: 'USD',
        observedAt: wallet.probed_at,
        ...(wallet.last_error !== null ? { reasonCode: wallet.last_error } : {}),
      },
    });
  }
  return rows;
}

async function readManifestSource(
  rawUrl: string,
  sourceIndex: number,
  options: TrustedUpstreamManifestOptions,
): Promise<SiteUpstreamWalletCandidate[]> {
  const endpoint = await validateManifestEndpoint(rawUrl, options.resolve);
  if (options.force === true) endpoint.searchParams.set('force', '1');

  const response = await (options.fetchFn ?? fetch)(endpoint.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (!response.ok) throw new Error('manifest_http_error');
  return mapManifestWallets(await readBoundedJson(response), endpoint, sourceIndex);
}

/**
 * 读取受信任二跳钱包清单。每个来源独立失败，输出始终由显式白名单字段重新构造，
 * 不会透传清单中的 key/token/raw 或未知字段。
 */
export async function readTrustedUpstreamManifests(
  urls: readonly string[],
  options: TrustedUpstreamManifestOptions = {},
): Promise<SiteUpstreamWalletCandidate[]> {
  const perSource = await Promise.all(
    urls.map((url, index) => readManifestSource(url, index, options).catch(() => [])),
  );
  return perSource.flat();
}
