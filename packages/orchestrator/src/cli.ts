/**
 * 开发用 CLI（正式 CLI 在 P3 打磨）：
 *   node dist/cli.js provision <slug> <version> <port> [--engine sub2api|newapi]
 *   node dist/cli.js verify <slug> <port>          — adapter 全链路 E2E（sub2api）
 *   node dist/cli.js destroy <slug> <port> [--keep-data]
 * 凭据处理：开发模式明文写入站点目录 credentials.json（仅本机测试！生产走加密凭据库）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sub2apiAdapter } from '@relay-panel/adapter-sub2api';
import type { CredentialStore, EngineKind, InstanceInfo } from '@relay-panel/adapter-core';
import { makeLifecycles } from './provision/index.js';

const sitesRoot = process.env.RP_SITES_ROOT ?? join(process.cwd(), 'data', 'sites');

async function devStore(slug: string, secrets: Record<string, string>): Promise<string> {
  const path = join(sitesRoot, slug, 'credentials.json');
  await writeFile(path, JSON.stringify({ kind: 'dev-plaintext', ...secrets }, null, 2), 'utf8');
  return `devfile:${path}`;
}
const onStep = async (slug: string, step: string, status: string, detail?: string) => {
  console.log(`[${slug}] ${step}: ${status}${detail ? ` — ${detail}` : ''}`);
};

const lifecycles = makeLifecycles({
  sub2api: { sitesRoot, storeCredential: (s, sec) => devStore(s, sec), onStep },
  newapi: { sitesRoot, storeCredential: (s, sec) => devStore(s, sec), onStep },
});

const argv = process.argv.slice(2);
const [cmd, slug, a, b] = argv;
const engineFlag = argv[argv.indexOf('--engine') + 1];
const engine: EngineKind = engineFlag === 'newapi' ? 'newapi' : 'sub2api';

if (cmd === 'provision' && slug && a && b) {
  const inst = await lifecycles[engine].provision({
    slug,
    engine,
    version: a,
    domains: [],
    hostPort: Number(b),
    database: { mode: 'dedicated', dbName: engine },
    adminEmail: `admin@${slug}.local`,
  });
  console.log('provisioned:', JSON.stringify(inst, null, 2));
} else if (cmd === 'verify' && slug && a) {
  const inst: InstanceInfo = {
    siteSlug: slug,
    engine: 'sub2api',
    version: 'n/a',
    baseUrl: `http://127.0.0.1:${a}`,
    dataDir: join(sitesRoot, slug),
    composeProject: `rp-${slug}`,
    credentialRef: `devfile:${join(sitesRoot, slug, 'credentials.json')}`,
  };
  const store: CredentialStore = {
    resolve: async (ref) => {
      const file = JSON.parse(await readFile(ref.replace(/^devfile:/, ''), 'utf8'));
      return { kind: 'admin-password', secret: file.adminPassword, adminEmail: file.adminEmail };
    },
  };
  const adapter = new Sub2apiAdapter();

  console.log('health:', JSON.stringify(await adapter.health(inst)));
  const client = await adapter.connect(inst, store);
  console.log('connect: ok (admin session established)');

  const group = await client.groups.create({ name: 'rp-e2e-group', ratio: 1.5, description: 'relay-panel E2E' });
  console.log('group created:', JSON.stringify(group));

  const channel = await client.channels.create({
    name: 'rp-e2e-upstream',
    protocol: 'anthropic',
    baseUrl: 'https://example.invalid',
    apiKey: 'sk-e2e-dummy',
    models: [],
    groups: [group.id],
  });
  console.log('channel(account) created:', JSON.stringify(channel));

  const channels = await client.channels.list();
  console.log('channels list:', channels.length, 'entries');

  const disabled = await client.channels.update(channel.id, { enabled: false });
  console.log('channel disabled:', disabled.enabled === false);

  const users = await client.users.list();
  console.log('users:', JSON.stringify(users.map((u) => ({ id: u.id, role: u.role, status: u.status }))));

  const branding = await client.settings.getBranding();
  console.log('branding:', JSON.stringify(branding));

  const now = new Date();
  const usage = await client.stats.usage(new Date(now.getTime() - 86400000), now);
  console.log('usage:', JSON.stringify(usage));

  await client.channels.remove(channel.id);
  console.log('channel removed: ok');
  console.log('E2E VERIFY: ALL PASS');
} else if (cmd === 'destroy' && slug && a) {
  await lifecycles[engine].destroy(
    {
      siteSlug: slug,
      engine,
      version: 'n/a',
      baseUrl: `http://127.0.0.1:${a}`,
      dataDir: join(sitesRoot, slug),
      composeProject: `rp-${slug}`,
      credentialRef: 'n/a',
    },
    { keepData: process.argv.includes('--keep-data') },
  );
  console.log('destroyed');
} else {
  console.log(
    'usage: cli.ts provision <slug> <version> <port> [--engine sub2api|newapi] | verify <slug> <port> | destroy <slug> <port> [--engine ..] [--keep-data]',
  );
  process.exit(1);
}
