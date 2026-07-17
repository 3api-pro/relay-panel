import { describe, expect, it } from 'vitest';
import { makeLifecycles } from '../src/provision/index.js';

const noop = async () => 'ref';

describe('makeLifecycles', () => {
  const lc = makeLifecycles({
    sub2api: { sitesRoot: '/tmp', storeCredential: noop },
    newapi: { sitesRoot: '/tmp', storeCredential: noop },
  });

  it('returns a lifecycle per engine, tagged correctly', () => {
    expect(lc.sub2api.engine).toBe('sub2api');
    expect(lc.newapi.engine).toBe('newapi');
  });

  it('rejects engine mismatch on provision', async () => {
    await expect(
      lc.newapi.provision({
        slug: 's',
        engine: 'sub2api',
        version: '1',
        domains: [],
        hostPort: 1,
        database: { mode: 'dedicated', dbName: 'x' },
        adminEmail: 'a@b',
      }),
    ).rejects.toThrow(/wrong engine/);
  });
});
