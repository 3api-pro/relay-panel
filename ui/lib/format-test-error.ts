// Map a raw channel-test result (machine-named `category` / `error`) to a
// user-facing message via i18n. See services/channel-test.ts for the wire
// shape — category is one of: 'ok' | 'auth' | 'rate_limit' | 'unreachable'
// | 'protocol' | 'not_implemented'. Anything outside that set falls through
// to the raw-string template.
export interface TestResultShape {
  ok?: boolean;
  category?: string;
  error?: string;
  status?: number;
}

type Translator = (key: string, params?: Record<string, any>) => string;

const KNOWN_CATEGORIES = new Set([
  'auth',
  'rate_limit',
  'unreachable',
  'protocol',
  'not_implemented',
]);

export function formatTestError(r: TestResultShape, t: Translator): string {
  const cat = r.category;
  if (cat && KNOWN_CATEGORIES.has(cat)) {
    return t(`test_err_${cat}`, { raw: r.error ?? '' });
  }
  return t('test_err_unknown', { raw: r.error ?? `HTTP ${r.status ?? '?'}` });
}
