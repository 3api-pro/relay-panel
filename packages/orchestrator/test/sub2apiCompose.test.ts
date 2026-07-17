import { describe, expect, it } from 'vitest';
import {
  renderSub2apiCompose,
  renderSub2apiEnv,
  type Sub2apiComposeInput,
} from '../src/provision/sub2apiCompose.js';

const input: Sub2apiComposeInput = {
  slug: 'demo1',
  version: '0.1.160',
  hostPort: 18080,
  adminEmail: 'admin@demo1.local',
  postgresPassword: 'pgpass',
  jwtSecret: 'a'.repeat(64),
  totpEncryptionKey: 'b'.repeat(64),
  adminPassword: 'admpass',
};

describe('renderSub2apiCompose', () => {
  it('rejects latest tag', () => {
    expect(() => renderSub2apiCompose({ ...input, version: 'latest' })).toThrow(/pinned/);
  });

  it('binds engine port to loopback only', () => {
    expect(renderSub2apiCompose(input)).toContain('"127.0.0.1:${SERVER_PORT}:8080"');
  });

  it('has no per-service container_name (multi-site coexistence)', () => {
    expect(renderSub2apiCompose(input)).not.toContain('container_name');
  });

  it('sets PGDATA explicitly (postgres:18-alpine data-loss trap)', () => {
    expect(renderSub2apiCompose(input)).toContain('PGDATA=/var/lib/postgresql/data');
  });
});

describe('renderSub2apiEnv', () => {
  it('round-trips all secrets', () => {
    const env = renderSub2apiEnv(input);
    for (const [k, v] of [
      ['SUB2API_VERSION', '0.1.160'],
      ['SERVER_PORT', '18080'],
      ['POSTGRES_PASSWORD', 'pgpass'],
      ['JWT_SECRET', 'a'.repeat(64)],
      ['ADMIN_EMAIL', 'admin@demo1.local'],
      ['ADMIN_PASSWORD', 'admpass'],
    ]) {
      expect(env).toContain(`${k}=${v}`);
    }
  });
});
