import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { inspectLocalEnvironment, assertPinnedVersion, type EnvironmentDependencies } from '../src/provision/environment.js';
import { loadConfig } from '../src/config.js';
import { makeTestServer, type TestServer } from './helpers.js';
import { sites, jobs } from '../src/db/schema.js';

function environment(overrides: Partial<EnvironmentDependencies> = {}): EnvironmentDependencies {
  return { container: false, disk: async () => 20 * 1024 ** 3, command: async args => {
    if (args[0] === 'info') return JSON.stringify({ ServerVersion: '27.0.0', OSType: 'linux', MemTotal: 4 * 1024 ** 3, NCPU: 4 });
    if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (args[0] === 'compose') return '2.30.0';
    return 'bridge';
  }, ...overrides };
}
describe('local application environment', () => {
  it('enables installation for self-hosting and never for SaaS', () => {
    expect(loadConfig({}).localProvisionEnabled).toBe(true);
    expect(loadConfig({ RP_DEPLOYMENT_MODE: 'saas', RP_LOCAL_PROVISION_ENABLED: '1' }).localProvisionEnabled).toBe(false);
  });
  it('checks runtime, compose, permissions and space without mutating the host', async () => {
    expect((await inspectLocalEnvironment('/unused', false, environment())).ready).toBe(true);
    expect((await inspectLocalEnvironment('/unused', false, environment({ disk: async () => 100 }))).ready).toBe(false);
    const failure = await inspectLocalEnvironment('/unused', false, environment({ command: async () => { throw new Error('PRIVATE-STDERR'); } }));
    expect(failure.ready).toBe(false); expect(JSON.stringify(failure)).not.toContain('PRIVATE-STDERR');
  });
  it('refuses remote Docker and bridge-only panel containers', async () => {
    const base = environment();
    const remote = environment({ command: args => args[0] === 'context' ? Promise.resolve(JSON.stringify('ssh://remote')) : base.command(args) });
    expect((await inspectLocalEnvironment('/unused', false, remote)).ready).toBe(false);
    expect((await inspectLocalEnvironment('/unused', false, environment({ container: true }))).checks.find(c => c.key === 'network')?.ok).toBe(false);
  });
  it('rejects environment expressions and mutable latest tags before rendering', () => {
    for (const tag of ['latest', 'v1\nADMIN_PASSWORD=bad', '${PRIVATE}', 'tag;command', '../other']) expect(() => assertPinnedVersion(tag)).toThrow();
    expect(() => assertPinnedVersion('v1.2.3')).not.toThrow();
  });
});

describe('local installation identity and recovery', () => {
  let ts: TestServer, cookie: string;
  beforeAll(async () => { ts = await makeTestServer({ config: { portRange: { min: 19510, max: 19520 } } }); cookie = (await ts.seedLogin({ email: 'local-admin@example.test', password: 'correct-password' })).cookie; });
  afterAll(async () => ts.close());
  it('generates IDs and ports, then retries a failed installation without creating a second site', async () => {
    const create = await ts.app.inject({ method: 'POST', url: '/api/sites', cookies: { rp_session: cookie }, payload: { label: 'My local engine', engine: 'sub2api', version: 'v1.2.3', adminEmail: 'engine@example.test' } });
    expect(create.statusCode).toBe(201); const { slug, jobId, hostPort } = create.json();
    expect(slug).toMatch(/^s-[a-f0-9]{30}$/); expect(hostPort).toBe(19510);
    await ts.db.orm.update(sites).set({ status: 'failed:environment-check' }).where(eq(sites.slug, slug));
    await ts.db.orm.update(jobs).set({ status: 'failed', error: 'Docker was unavailable' }).where(eq(jobs.id, jobId));
    const retry = () => ts.app.inject({ method: 'POST', url: `/api/sites/${slug}/retry-install`, cookies: { rp_session: cookie } });
    expect((await retry()).statusCode).toBe(200); expect((await retry()).statusCode).toBe(409);
    expect(await ts.db.orm.select().from(sites)).toHaveLength(1);
    expect(await ts.db.orm.select().from(jobs)).toHaveLength(2);
  });
});
