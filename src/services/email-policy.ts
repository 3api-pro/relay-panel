/**
 * email-policy — registration email-domain policy (blocklist + optional
 * allowlist). Ported from llmapi-v2/src/services/email-policy.ts to PG +
 * 3api's app-config-style cache pattern.
 *
 * Source of truth:
 *   blocked_email_domains  — always rejected. '.' prefix = wildcard suffix.
 *   allowed_email_domains  — if non-empty, WHITELIST mode (only listed).
 *
 * Cache refresh: 60s poll. env BLOCKED_EMAIL_DOMAINS = break-glass blocker
 * (kept for parity; production should use the DB).
 *
 * Also exposes canonicalizeEmail() — strips +tag on common providers and
 * removes dots in gmail.com localpart. Use this BEFORE inserting an
 * end_user / reseller_admin to prevent alias abuse from one signup buying
 * multiple verify emails.
 */
import { query } from './database';
import { logger } from './logger';

const REFRESH_MS = 60_000;

let allowedCache: Set<string> = new Set();
let blockedCache: Set<string> = new Set();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

function envBlocked(): string[] {
  return (process.env.BLOCKED_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function reload(): Promise<void> {
  try {
    const aRows = await query<{ domain: string }>('SELECT domain FROM allowed_email_domains');
    const bRows = await query<{ domain: string }>('SELECT domain FROM blocked_email_domains');
    const a = new Set<string>();
    const b = new Set<string>();
    for (const r of aRows) if (typeof r.domain === 'string') a.add(r.domain.toLowerCase().trim());
    for (const r of bRows) if (typeof r.domain === 'string') b.add(r.domain.toLowerCase().trim());
    for (const d of envBlocked()) b.add(d);
    allowedCache = a;
    blockedCache = b;
    lastRefresh = Date.now();
  } catch (err: any) {
    logger.error({ err: err.message }, 'email-policy:reload_failed_keeping_stale');
  }
}

export async function initEmailPolicy(): Promise<void> {
  await reload();
  const t = setInterval(() => {
    reload().catch(() => {});
  }, REFRESH_MS);
  if (t.unref) t.unref();
  logger.info(
    { allowed: allowedCache.size, blocked: blockedCache.size },
    'email-policy:loaded',
  );
}

function ensureFresh(): void {
  if (refreshing) return;
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  refreshing = reload().finally(() => {
    refreshing = null;
  });
}

function domainOf(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

export type EmailPolicyResult = { ok: true } | { ok: false; reason: 'blocked' | 'not_allowlisted' };

function isDomainBlocked(domain: string): boolean {
  if (blockedCache.has(domain)) return true;
  for (const entry of blockedCache) {
    if (entry.startsWith('.') && (domain === entry.slice(1) || domain.endsWith(entry))) {
      return true;
    }
  }
  return false;
}

export function evaluateEmail(email: unknown): EmailPolicyResult {
  ensureFresh();
  const d = domainOf(email);
  if (!d) return { ok: false, reason: 'blocked' };
  if (isDomainBlocked(d)) return { ok: false, reason: 'blocked' };
  if (allowedCache.size > 0 && !allowedCache.has(d)) return { ok: false, reason: 'not_allowlisted' };
  return { ok: true };
}

export function isDisposableEmail(email: unknown): boolean {
  return !evaluateEmail(email).ok;
}

/**
 * Canonical form for uniqueness checks.
 *   gmail / googlemail  → strip dots in localpart, drop "+tag", rewrite to gmail.com
 *   outlook / hotmail / live / yahoo / icloud / me / mac / proton  → drop "+tag"
 *   else  → lowercase only
 */
const PLUS_TAG_DOMAINS = new Set([
  'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
]);

export function canonicalizeEmail(raw: string): string {
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw.toLowerCase().trim();
  const local = raw.slice(0, at).toLowerCase();
  const domain = raw.slice(at + 1).toLowerCase().trim();
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const noTag = local.split('+')[0];
    const noDots = noTag.replace(/\./g, '');
    return `${noDots}@gmail.com`;
  }
  if (PLUS_TAG_DOMAINS.has(domain)) {
    const noTag = local.split('+')[0];
    return `${noTag}@${domain}`;
  }
  return `${local}@${domain}`;
}

export function listAllowedDomains(): string[] {
  return Array.from(allowedCache).sort();
}
export function listBlockedDomains(): string[] {
  return Array.from(blockedCache).sort();
}

// -- DB mutators (admin path) -----------------------------------------------
function validateDomain(d: string): string {
  const v = d.toLowerCase().trim();
  if (!v || v.includes('@') || !v.includes('.')) throw new Error('Invalid domain');
  return v;
}

export async function addBlockedDomain(
  domain: string,
  reason: string,
  createdBy: string,
): Promise<void> {
  const d = validateDomain(domain);
  await query(
    `INSERT INTO blocked_email_domains (domain, reason, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (domain) DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by`,
    [d, reason || '', createdBy || ''],
  );
  await reload();
}

export async function removeBlockedDomain(domain: string): Promise<boolean> {
  const d = validateDomain(domain);
  const rows = await query<{ domain: string }>(
    'DELETE FROM blocked_email_domains WHERE domain = $1 RETURNING domain',
    [d],
  );
  await reload();
  return rows.length > 0;
}

// -- Per-recipient cooldown (anti-spam verification flood) ------------------
/**
 * Returns true if `toEmail` has received any send (success OR attempted)
 * within the last `withinSeconds`. The caller should reject duplicate sends.
 */
export async function recentlySentTo(toEmail: string, withinSeconds: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM email_send_log
      WHERE to_email = $1 AND sent_at > now() - ($2::int || ' seconds')::interval
      LIMIT 1`,
    [toEmail.toLowerCase(), withinSeconds],
  );
  return rows.length > 0;
}

export async function logEmailSent(
  toEmail: string,
  template: string,
  status: 'sent' | 'failed' | 'skipped',
  provider: string | null,
  tenantId: number | null,
  errShort: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO email_send_log (to_email, template, status, provider, tenant_id, err_short)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [toEmail.toLowerCase(), template, status, provider, tenantId, errShort],
    );
  } catch (err: any) {
    logger.warn({ err: err.message }, 'email-send-log:insert_failed');
  }
}
