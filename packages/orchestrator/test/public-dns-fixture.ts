import { vi } from 'vitest';

// These suites use fake adapters and example.com fixtures, not live upstreams.
// Local VPN/fake-IP DNS must not turn a valid-channel test into an SSRF rejection.
// Keep the URL guard itself real; its dedicated suite covers denied addresses.
vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: (hostname: string, options: unknown) => {
      if (hostname === 'example.com' || hostname.endsWith('.example.com')) {
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      }
      return actual.lookup(hostname, options as { all: true });
    },
  };
});
