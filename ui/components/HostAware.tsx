'use client';
/**
 * Host-based routing helper (Task #17).
 *
 * Why this exists:
 *   Next.js Route Groups can't claim the same URL twice (e.g. /, /login)
 *   but we need TWO different pages at those URLs:
 *     - root domain 3api.pro  → 3api marketing / 3api Panel admin signup
 *     - tenant subdomain      → branded storefront for end users
 *   Static export (`output: 'export'`) also rules out Next middleware
 *   rewrites, so we decide on the client right at hydration.
 *
 * Detection:
 *   `window.location.host` is matched against ROOT_DOMAINS. Anything else
 *   is treated as a tenant subdomain or custom domain. Production hosts:
 *     - 3api.pro / www.3api.pro                       → root (marketing)
 *     - <slug>.3api.pro                               → store
 *     - localhost / 127.0.0.1 / 0.0.0.0 / 192.168.*   → root (dev marketing)
 *     - <slug>.localhost (curl Host: header tests)    → store
 *
 * The mode is `null` during SSR / before hydration. Pages that branch on
 * mode should render a neutral placeholder until the value is non-null
 * (a hairline flash is acceptable; otherwise the marketing HTML would
 * flicker on store subdomains).
 */
import { useEffect, useState } from 'react';

export type HostMode = 'marketing' | 'store';

const ROOT_HOSTS = new Set<string>([
  '3api.pro',
  'www.3api.pro',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
]);

export function detectMode(host: string): HostMode {
  if (!host) return 'marketing';
  const noPort = host.split(':')[0].toLowerCase();
  if (ROOT_HOSTS.has(noPort)) return 'marketing';
  // Private LAN ranges → root marketing for dev convenience.
  if (/^10\./.test(noPort) || /^192\.168\./.test(noPort) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(noPort)) {
    return 'marketing';
  }
  return 'store';
}

export function useHostMode(): HostMode | null {
  const [mode, setMode] = useState<HostMode | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setMode(detectMode(window.location.host));
  }, []);
  return mode;
}
