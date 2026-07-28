/**
 * Pure parsers for the two read-only upstream wallet protocols.
 *
 * The caller must pass the raw response body and Content-Type. This module does
 * not perform I/O, accept credentials, or include response bodies in results.
 */

export type WalletProtocol = 'sub2api' | 'newapi';

export type WalletParseStatus =
  | 'ok'
  | 'partial'
  | 'invalid_content_type'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'invalid_number'
  | 'placeholder_limit';

export type WalletCoverage = 'full' | 'balance_only' | 'usage_only' | 'none';

export interface RawWalletResponse {
  /** Raw Content-Type header. JSON parameters such as charset are accepted. */
  contentType?: string | null;
  /** Raw, size-limited response body supplied by the network layer. */
  body: string;
}

export interface WalletParseResult {
  status: WalletParseStatus;
  /** null means the payload did not strongly match the expected protocol. */
  protocol: WalletProtocol | null;
  /** Wallet balance in the upstream's billing display unit. */
  balance: number | null;
  /** Usage/cost in the same billing display unit. */
  usage: number | null;
  coverage: WalletCoverage;
}

export interface NewApiBillingWalletResponses {
  subscription: RawWalletResponse;
  /** Must be a lifetime/all-time usage response when balance is required. */
  lifetimeUsage: RawWalletResponse;
}

/** NewAPI uses this exact value for unlimited/hidden quota. */
export const NEWAPI_PLACEHOLDER_LIMIT = 100_000_000;
/** NewAPI's billing usage endpoint reports hundredths of the display unit. */
export const NEWAPI_USAGE_UNITS_PER_DISPLAY_UNIT = 100;

type DecodeFailureStatus = 'invalid_content_type' | 'invalid_json';
type DecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; status: DecodeFailureStatus };

interface NewApiSubscriptionParse {
  status: WalletParseStatus;
  protocol: WalletProtocol | null;
  hardLimit: number | null;
}

function emptyResult(
  status: WalletParseStatus,
  protocol: WalletProtocol | null = null,
): WalletParseResult {
  return { status, protocol, balance: null, usage: null, coverage: 'none' };
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const mediaType = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/json' ||
    (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

function decodeJson(input: RawWalletResponse): DecodeResult {
  if (!isJsonContentType(input.contentType)) {
    return { ok: false, status: 'invalid_content_type' };
  }
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    return { ok: false, status: 'invalid_json' };
  }
  try {
    return { ok: true, value: JSON.parse(input.body.replace(/^\uFEFF/, '')) as unknown };
  } catch {
    return { ok: false, status: 'invalid_json' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && Number.isInteger(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function coverageFor(balance: number | null, usage: number | null): WalletCoverage {
  if (balance !== null && usage !== null) return 'full';
  if (balance !== null) return 'balance_only';
  if (usage !== null) return 'usage_only';
  return 'none';
}

function validateOptionalDailyCounters(row: Record<string, unknown>): boolean {
  const counterFields = [
    'requests',
    'input_tokens',
    'output_tokens',
    'cache_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'total_tokens',
  ];
  for (const field of counterFields) {
    if (field in row && !isNonNegativeInteger(row[field])) return false;
  }
  return true;
}

/**
 * Parse Sub2API GET /v1/usage.
 *
 * A strong protocol match requires both `mode` and `isValid`. Wallet balance
 * and daily usage are optional because Sub2API can return subscription/quota
 * modes; missing wallet fields are represented as partial coverage, never 0.
 */
export function parseSub2ApiUsageResponse(input: RawWalletResponse): WalletParseResult {
  const decoded = decodeJson(input);
  if (!decoded.ok) return emptyResult(decoded.status);
  if (!isRecord(decoded.value)) return emptyResult('schema_mismatch');

  const payload = decoded.value;
  if (
    (payload.mode !== 'unrestricted' && payload.mode !== 'quota_limited') ||
    typeof payload.isValid !== 'boolean'
  ) {
    return emptyResult('schema_mismatch');
  }

  const protocol: WalletProtocol = 'sub2api';
  let balance: number | null = null;
  if ('balance' in payload) {
    if (typeof payload.balance !== 'number') return emptyResult('schema_mismatch', protocol);
    if (!Number.isFinite(payload.balance)) return emptyResult('invalid_number', protocol);
    balance = payload.balance;
  }

  let usage: number | null = null;
  if ('daily_usage' in payload) {
    if (!Array.isArray(payload.daily_usage)) return emptyResult('schema_mismatch', protocol);
    let total = 0;
    for (const item of payload.daily_usage) {
      if (!isRecord(item) || !isIsoDate(item.date) || typeof item.cost !== 'number') {
        return emptyResult('schema_mismatch', protocol);
      }
      if (!isNonNegativeFiniteNumber(item.cost)) return emptyResult('invalid_number', protocol);
      if ('actual_cost' in item && !isNonNegativeFiniteNumber(item.actual_cost)) {
        return emptyResult('invalid_number', protocol);
      }
      if (!validateOptionalDailyCounters(item)) return emptyResult('invalid_number', protocol);
      total += item.cost;
      if (!Number.isFinite(total)) return emptyResult('invalid_number', protocol);
    }
    usage = total;
  }

  const coverage = coverageFor(balance, usage);
  return {
    status: coverage === 'full' ? 'ok' : 'partial',
    protocol,
    balance,
    usage,
    coverage,
  };
}

function parseNewApiSubscription(input: RawWalletResponse): NewApiSubscriptionParse {
  const decoded = decodeJson(input);
  if (!decoded.ok) return { status: decoded.status, protocol: null, hardLimit: null };
  if (!isRecord(decoded.value) || decoded.value.object !== 'billing_subscription') {
    return { status: 'schema_mismatch', protocol: null, hardLimit: null };
  }

  const payload = decoded.value;
  const protocol: WalletProtocol = 'newapi';
  if (
    typeof payload.has_payment_method !== 'boolean' ||
    typeof payload.soft_limit_usd !== 'number' ||
    typeof payload.hard_limit_usd !== 'number' ||
    typeof payload.system_hard_limit_usd !== 'number' ||
    typeof payload.access_until !== 'number'
  ) {
    return { status: 'schema_mismatch', protocol, hardLimit: null };
  }
  if (
    !isNonNegativeFiniteNumber(payload.soft_limit_usd) ||
    !isNonNegativeFiniteNumber(payload.hard_limit_usd) ||
    !isNonNegativeFiniteNumber(payload.system_hard_limit_usd) ||
    !isNonNegativeInteger(payload.access_until)
  ) {
    return { status: 'invalid_number', protocol, hardLimit: null };
  }
  if (payload.hard_limit_usd >= NEWAPI_PLACEHOLDER_LIMIT) {
    return { status: 'placeholder_limit', protocol, hardLimit: null };
  }
  return { status: 'ok', protocol, hardLimit: payload.hard_limit_usd };
}

/** Parse NewAPI GET /dashboard/billing/usage as a usage-only result. */
export function parseNewApiBillingUsageResponse(input: RawWalletResponse): WalletParseResult {
  const decoded = decodeJson(input);
  if (!decoded.ok) return emptyResult(decoded.status);
  if (!isRecord(decoded.value) || decoded.value.object !== 'list') {
    return emptyResult('schema_mismatch');
  }

  const protocol: WalletProtocol = 'newapi';
  if (typeof decoded.value.total_usage !== 'number') {
    return emptyResult('schema_mismatch', protocol);
  }
  if (!isNonNegativeFiniteNumber(decoded.value.total_usage)) {
    return emptyResult('invalid_number', protocol);
  }
  const usage = decoded.value.total_usage / NEWAPI_USAGE_UNITS_PER_DISPLAY_UNIT;
  if (!Number.isFinite(usage)) return emptyResult('invalid_number', protocol);
  return { status: 'ok', protocol, balance: null, usage, coverage: 'usage_only' };
}

/**
 * Parse and combine NewAPI billing subscription + lifetime usage responses.
 * `hard_limit_usd` is a total limit, so wallet balance is limit minus all-time
 * usage. A 1e8 unlimited/hidden limit is never exposed as a real balance.
 */
export function parseNewApiBillingWalletResponses(
  input: NewApiBillingWalletResponses,
): WalletParseResult {
  const subscription = parseNewApiSubscription(input.subscription);
  const usage = parseNewApiBillingUsageResponse(input.lifetimeUsage);
  const protocol = subscription.protocol ?? usage.protocol;

  if (subscription.status === 'placeholder_limit') {
    const parsedUsage = usage.status === 'ok' ? usage.usage : null;
    return {
      status: 'placeholder_limit',
      protocol: 'newapi',
      balance: null,
      usage: parsedUsage,
      coverage: parsedUsage === null ? 'none' : 'usage_only',
    };
  }

  if (subscription.status !== 'ok' || subscription.hardLimit === null) {
    const parsedUsage = usage.status === 'ok' ? usage.usage : null;
    return {
      status: subscription.status,
      protocol,
      balance: null,
      usage: parsedUsage,
      coverage: parsedUsage === null ? 'none' : 'usage_only',
    };
  }

  if (usage.status !== 'ok' || usage.usage === null) {
    return emptyResult(usage.status, protocol);
  }

  const balance = subscription.hardLimit - usage.usage;
  if (!Number.isFinite(balance)) return emptyResult('invalid_number', 'newapi');
  return { status: 'ok', protocol: 'newapi', balance, usage: usage.usage, coverage: 'full' };
}
