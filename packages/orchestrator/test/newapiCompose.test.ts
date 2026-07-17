import { describe, expect, it } from 'vitest';
import { renderNewapiCompose, renderNewapiEnv, type NewapiComposeInput } from '../src/provision/newapiCompose.js';

const input: NewapiComposeInput = {
  slug: 'na1',
  version: 'v1.0.0-rc.21',
  hostPort: 13000,
  sessionSecret: 'x'.repeat(32),
};

describe('renderNewapiCompose', () => {
  it('rejects latest tag', () => {
    expect(() => renderNewapiCompose({ ...input, version: 'latest' })).toThrow(/pinned/);
  });

  it('maps host port to container port 3000 on loopback', () => {
    expect(renderNewapiCompose(input)).toContain('"127.0.0.1:${SERVER_PORT}:3000"');
  });

  it('has no container_name (multi-site coexistence)', () => {
    expect(renderNewapiCompose(input)).not.toContain('container_name');
  });

  it('health-checks /api/status', () => {
    expect(renderNewapiCompose(input)).toContain('/api/status');
  });
});

describe('renderNewapiEnv', () => {
  it('carries per-site session secret and empty SQL_DSN by default (SQLite)', () => {
    const env = renderNewapiEnv(input);
    expect(env).toContain('SESSION_SECRET=' + 'x'.repeat(32));
    expect(env).toContain('SQL_DSN=\n');
  });
});
