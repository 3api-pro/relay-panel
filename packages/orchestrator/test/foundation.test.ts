import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { loadConfig } from '../src/config.js';
import { makeDb, runMigrations, type Db } from '../src/db/client.js';
import {
  alerts,
  appSettings,
  auditEvents,
  channelGrants,
  channelTemplates,
  credentials,
  jobs,
  operators,
  plans,
  sites,
  usageLedger,
} from '../src/db/schema.js';
import { decryptSecret, encryptSecret } from '../src/secrets.js';
import { redact, writeAudit } from '../src/audit.js';
import { makeCredentialStoreV2 } from '../src/credstore.js';
import { importRegistry } from '../src/registryImport.js';
import { makeTestConfig, seedOperator } from './helpers.js';

// pglite WASM 单实例冷启动约 4s，放宽超时；大部分用例共享一个库以省启动
vi.setConfig({ testTimeout: 30_000 });

let db: Db; // 共享库：首个用例即验证 migrate 幂等
const tmpDirs: string[] = [];

async function freshTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rp-foundation-'));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  db = await makeDb('pglite:memory');
}, 60_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('config: loadConfig', () => {
  it('空 env 全默认值', () => {
    const c = loadConfig({});
    expect(c.port).toBe(7100);
    expect(c.host).toBe('127.0.0.1');
    expect(c.dbUrl).toBe('pglite:./data/orchestrator-db');
    expect(c.signupMode).toBe('closed');
    expect(c.sessionTtlHours).toBe(168);
    expect(c.portRange).toEqual({ min: 18100, max: 18999 });
    expect(c.dockerViaWsl).toBe(false);
    expect(c.monitorIntervalMs).toBe(60_000);
    expect(c.ledgerPullIntervalMs).toBe(3_600_000);
    expect(c.webDist).toBe('../web/dist');
    expect(c.secretKey).toBeUndefined();
    expect(c.meteringGatewayUrl).toBeUndefined();
    expect(c.caddyAdminUrl).toBeUndefined();
    expect(c.metricsToken).toBeUndefined();
  });

  it('解析自定义值与端口池', () => {
    const c = loadConfig({
      PORT: '8123',
      RP_SIGNUP_MODE: 'invite',
      RP_PORT_RANGE: '20000-20010',
      RP_DOCKER_VIA_WSL: '1',
      RP_SECRET_KEY: 'k1',
      RP_METERING_GATEWAY_URL: 'https://gateway.example.com',
    });
    expect(c.port).toBe(8123);
    expect(c.signupMode).toBe('invite');
    expect(c.portRange).toEqual({ min: 20000, max: 20010 });
    expect(c.dockerViaWsl).toBe(true);
    expect(c.secretKey).toBe('k1');
    expect(c.meteringGatewayUrl).toBe('https://gateway.example.com');
  });

  it('空串 env 视为未设置', () => {
    const c = loadConfig({ RP_SECRET_KEY: '', RP_SIGNUP_MODE: '' });
    expect(c.secretKey).toBeUndefined();
    expect(c.signupMode).toBe('closed');
  });

  it('非法值报错', () => {
    expect(() => loadConfig({ RP_SIGNUP_MODE: 'anything' })).toThrow(/RP_SIGNUP_MODE/);
    expect(() => loadConfig({ RP_PORT_RANGE: '2000-1000' })).toThrow(/RP_PORT_RANGE/);
    expect(() => loadConfig({ RP_PORT_RANGE: 'abc' })).toThrow(/RP_PORT_RANGE/);
  });
});

describe('db: runMigrations + schema', () => {
  it('跑两遍幂等，记账一条', async () => {
    const first = await runMigrations(db);
    expect(first).toEqual(['001_init.sql', '002_saas_payments.sql']);
    const second = await runMigrations(db);
    expect(second).toEqual([]);
    const rows = await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    expect(rows).toEqual([{ name: '001_init.sql' }, { name: '002_saas_payments.sql' }]);
  });

  it('关键表可插查，默认值正确，plans 有三行种子', async () => {
    const seeded = await db.orm.select().from(plans);
    expect(seeded.map((p) => p.key).sort()).toEqual(['free', 'pro', 'scale']);
    expect(seeded.find((p) => p.key === 'free')?.siteQuota).toBe(1);
    expect(seeded.find((p) => p.key === 'scale')?.siteQuota).toBe(20);

    const opId = await seedOperator(db, { email: 'root@example.com', role: 'root' });
    const [site] = await db.orm
      .insert(sites)
      .values({
        operatorId: opId,
        slug: 'schema-site',
        label: 'Schema Site',
        engine: 'sub2api',
        version: '1.0.0',
        hostPort: 18100,
        baseUrl: 'http://127.0.0.1:18100',
      })
      .returning();
    expect(site!.status).toBe('pending');
    expect(site!.managed).toBe('compose');
    expect(site!.domains).toEqual([]);
    expect(site!.credentialRef).toBe('');
    expect(site!.createdAt).toBeTruthy();

    const [job] = await db.orm
      .insert(jobs)
      .values({ kind: 'provision', siteId: site!.id, slug: 'schema-site', createdBy: 'root@example.com' })
      .returning();
    expect(job!.status).toBe('queued');
    expect(job!.steps).toEqual([]);

    const [alert] = await db.orm
      .insert(alerts)
      .values({ kind: 'site_down', siteId: site!.id, severity: 'critical', title: '站点不可达' })
      .returning();
    expect(alert!.status).toBe('open');
    expect(alert!.firstSeenAt).toBeTruthy();

    await db.orm
      .insert(appSettings)
      .values({ key: 'alert_webhook_url', value: { url: 'https://hook.example.com' } });
    const setting = await db.orm.select().from(appSettings).where(eq(appSettings.key, 'alert_webhook_url'));
    expect(setting[0]?.value).toEqual({ url: 'https://hook.example.com' });
  });

  it('usage_ledger 的 (grant_id, period_start, source) 唯一约束生效', async () => {
    const ops = await db.orm.select({ id: operators.id }).from(operators).limit(1);
    const [site] = await db.orm
      .insert(sites)
      .values({
        operatorId: ops[0]!.id,
        slug: 'ledger-site',
        label: 'Ledger Site',
        engine: 'newapi',
        version: '1.0.0',
        hostPort: 18101,
        baseUrl: 'http://127.0.0.1:18101',
      })
      .returning();
    const [tpl] = await db.orm
      .insert(channelTemplates)
      .values({ key: 'tpl-a', title: '模板A', protocol: 'openai', models: ['model-x'] })
      .returning();
    const [grant] = await db.orm
      .insert(channelGrants)
      .values({ siteId: site!.id, templateId: tpl!.id, engineChannelId: '1' })
      .returning();

    const row = {
      grantId: grant!.id,
      periodStart: '2026-07-01 00:00:00',
      periodEnd: '2026-07-02 00:00:00',
      requests: 10,
    };
    await db.orm.insert(usageLedger).values(row);
    // drizzle 包一层 DrizzleQueryError，约束名在 cause 里
    const err = await db.orm.insert(usageLedger).values(row).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    const cause = (err as { cause?: unknown }).cause;
    expect(String(cause instanceof Error ? cause.message : cause)).toMatch(/duplicate|unique/i);
    // 不同 source 不冲突
    await db.orm.insert(usageLedger).values({ ...row, source: 'manual' });
    const all = await db.orm.select().from(usageLedger).where(eq(usageLedger.grantId, grant!.id));
    expect(all).toHaveLength(2);
  });
});

describe('secrets: encryptSecret/decryptSecret', () => {
  it('回环（passphrase 派生 key）', () => {
    const ct = encryptSecret('hello 世界', 'my-master-passphrase');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(decryptSecret(ct, 'my-master-passphrase')).toBe('hello 世界');
  });

  it('回环（64hex 直接作 key），且与同字面 passphrase 派生不互通', () => {
    const hexKey = 'ab'.repeat(32);
    const ct = encryptSecret('payload', hexKey);
    expect(decryptSecret(ct, hexKey)).toBe('payload');
    // 64hex 走直接解析分支；若误走 sha256(utf8) 派生则解不开
    const ctByDerived = encryptSecret('payload', 'not-hex-master');
    expect(() => decryptSecret(ctByDerived, hexKey)).toThrow(/decryption failed/);
  });

  it('同明文两次加密密文不同（随机 iv）', () => {
    const a = encryptSecret('same', 'k');
    const b = encryptSecret('same', 'k');
    expect(a).not.toBe(b);
  });

  it('篡改密文报错', () => {
    const ct = encryptSecret('secret-data', 'k');
    const body = ct.slice(3);
    const idx = Math.floor(body.length / 2);
    const flipped = body[idx] === 'A' ? 'B' : 'A';
    const tampered = 'v1:' + body.slice(0, idx) + flipped + body.slice(idx + 1);
    expect(() => decryptSecret(tampered, 'k')).toThrow(/decryption failed/);
  });

  it('错误 key 与非法格式报错', () => {
    const ct = encryptSecret('x', 'right-key');
    expect(() => decryptSecret(ct, 'wrong-key')).toThrow(/decryption failed/);
    expect(() => decryptSecret('plain-garbage', 'k')).toThrow(/format/);
    expect(() => decryptSecret('v1:QQ==', 'k')).toThrow(/too short/);
  });
});

describe('audit: redact / writeAudit', () => {
  it('深层脱敏且不改原对象', () => {
    const input = {
      apiKey: 'sk-live-abc',
      note: 'keep-me',
      nested: { adminPassword: 'p', list: [{ accessToken: 't', name: 'n' }] },
      credentialRef: 'enc:site-a',
      count: 3,
    };
    const out = redact(input);
    expect(out).toEqual({
      apiKey: '<redacted>',
      note: 'keep-me',
      nested: { adminPassword: '<redacted>', list: [{ accessToken: '<redacted>', name: 'n' }] },
      credentialRef: '<redacted>',
      count: 3,
    });
    // 原对象未被修改
    expect(input.apiKey).toBe('sk-live-abc');
    expect(input.nested.adminPassword).toBe('p');
  });

  it('敏感 key 命中时嵌套对象整体替换', () => {
    const out = redact({ credentials: { user: 'u', pass: 'p' }, plain: { a: 1 } });
    expect(out).toEqual({ credentials: '<redacted>', plain: { a: 1 } });
  });

  it('writeAudit 落库前强制脱敏 payload', async () => {
    await writeAudit(db, {
      actor: 'root@example.com',
      action: 'channel.create',
      payload: { name: 'ch-1', apiKey: 'sk-should-not-persist' },
      ok: true,
    });
    const rows = await db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'channel.create'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ name: 'ch-1', apiKey: '<redacted>' });
    expect(JSON.stringify(rows[0])).not.toContain('sk-should-not-persist');
  });
});

describe('credstore: makeCredentialStoreV2', () => {
  // db:<database> 分支不做单测：它需要一台真 PG（存量站引擎库的 settings.admin_api_key）
  // 和宿主机密码文件，属于生产接管链路，由真机 E2E（Phase I/J）覆盖；
  // 与 enc:/devfile: 共享的凭据映射逻辑（toEngineCredential）已在下方覆盖。

  it('enc: sub2api 形状（adminEmail+adminPassword）→ admin-password', async () => {
    const config = makeTestConfig();
    const secrets = {
      adminEmail: 'admin@site-a.example.com',
      adminPassword: 'pw-site-a',
      jwtSecret: 'jwt-x',
      postgresPassword: 'pg-x',
    };
    await db.orm.insert(credentials).values({
      ref: 'enc:site-a',
      kind: 'admin',
      ciphertext: encryptSecret(JSON.stringify(secrets), config.secretKey!),
    });
    const store = makeCredentialStoreV2(db, config);
    const cred = await store.resolve('enc:site-a');
    expect(cred).toEqual({
      kind: 'admin-password',
      secret: 'pw-site-a',
      adminEmail: 'admin@site-a.example.com',
    });
  });

  it('enc: newapi 形状（adminUsername+adminPassword）→ adminEmail 取 username', async () => {
    const config = makeTestConfig();
    await db.orm.insert(credentials).values({
      ref: 'enc:site-b',
      kind: 'admin',
      ciphertext: encryptSecret(
        JSON.stringify({ adminUsername: 'rootuser', adminPassword: 'pw-site-b' }),
        config.secretKey!,
      ),
    });
    const store = makeCredentialStoreV2(db, config);
    const cred = await store.resolve('enc:site-b');
    expect(cred).toEqual({ kind: 'admin-password', secret: 'pw-site-b', adminEmail: 'rootuser' });
  });

  it('enc: 有 adminApiKey → admin-token 优先', async () => {
    const config = makeTestConfig();
    await db.orm.insert(credentials).values({
      ref: 'enc:site-c',
      kind: 'admin',
      ciphertext: encryptSecret(
        JSON.stringify({ adminApiKey: 'ak-1', adminPassword: 'unused' }),
        config.secretKey!,
      ),
    });
    const store = makeCredentialStoreV2(db, config);
    expect(await store.resolve('enc:site-c')).toEqual({ kind: 'admin-token', secret: 'ak-1' });
  });

  it('enc: 缺 RP_SECRET_KEY / 缺记录时报错', async () => {
    const noKey = makeTestConfig();
    delete (noKey as { secretKey?: string }).secretKey;
    await expect(makeCredentialStoreV2(db, noKey).resolve('enc:x')).rejects.toThrow(/RP_SECRET_KEY/);
    await expect(makeCredentialStoreV2(db, makeTestConfig()).resolve('enc:missing')).rejects.toThrow(
      /not found/,
    );
  });

  it('devfile: 两种形状沿用现有语义', async () => {
    const dir = await freshTmpDir();
    const store = makeCredentialStoreV2(db, makeTestConfig());

    const tokenPath = join(dir, 'cred-token.json');
    await writeFile(tokenPath, JSON.stringify({ adminApiKey: 'ak-dev' }), 'utf8');
    expect(await store.resolve(`devfile:${tokenPath}`)).toEqual({ kind: 'admin-token', secret: 'ak-dev' });

    const pwPath = join(dir, 'cred-pw.json');
    await writeFile(
      pwPath,
      JSON.stringify({ adminEmail: 'a@example.com', adminPassword: 'pw-dev' }),
      'utf8',
    );
    expect(await store.resolve(`devfile:${pwPath}`)).toEqual({
      kind: 'admin-password',
      secret: 'pw-dev',
      adminEmail: 'a@example.com',
    });
  });

  it('未知 scheme 报错且只回显 scheme 前缀', async () => {
    const store = makeCredentialStoreV2(db, makeTestConfig());
    await expect(store.resolve('vault:path-with-secret')).rejects.toThrow(
      /unknown credentialRef scheme: vault/,
    );
    await expect(store.resolve('vault:path-with-secret')).rejects.not.toThrow(/path-with-secret/);
  });
});

describe('registryImport: importRegistry', () => {
  const IMPORT_SLUGS = ['site-a', 'site-b'];

  async function writeRegistry(dir: string, label: string, baseUrlA: string): Promise<string> {
    const path = join(dir, 'registry.json');
    await writeFile(
      path,
      JSON.stringify({
        credentialDb: {
          host: '127.0.0.1',
          port: 5432,
          user: 'postgres',
          passwordFile: join(dir, 'db-credentials.md'),
          passwordPattern: 'postgres/`([^`]+)`',
        },
        sites: [
          {
            slug: 'site-a',
            label,
            engine: 'sub2api',
            baseUrl: baseUrlA,
            credentialRef: 'db:engine_site_a',
          },
          {
            slug: 'site-b',
            label: 'site-b.example.com',
            engine: 'newapi',
            baseUrl: 'https://site-b.example.com',
            credentialRef: 'devfile:data/sites/site-b/credentials.json',
          },
        ],
      }),
      'utf8',
    );
    return path;
  }

  it('导入 + 重复导入幂等（冲突更新 label/baseUrl/credentialRef）', async () => {
    const dir = await freshTmpDir();
    const roots = await db.orm
      .select({ id: operators.id })
      .from(operators)
      .where(eq(operators.role, 'root'))
      .orderBy(asc(operators.id))
      .limit(1);
    const firstRootId = roots[0]!.id;

    const path1 = await writeRegistry(dir, 'Site A', 'http://127.0.0.1:8080');
    const r1 = await importRegistry(db, path1);
    expect(r1).toEqual({ sites: 2, credentialDb: true });

    let rows = await db.orm.select().from(sites).where(inArray(sites.slug, IMPORT_SLUGS));
    expect(rows).toHaveLength(2);
    const siteA = rows.find((s) => s.slug === 'site-a')!;
    expect(siteA.managed).toBe('external');
    expect(siteA.status).toBe('active');
    expect(siteA.operatorId).toBe(firstRootId);
    expect(siteA.hostPort).toBe(8080);
    expect(siteA.label).toBe('Site A');
    expect(siteA.credentialRef).toBe('db:engine_site_a');
    const siteB = rows.find((s) => s.slug === 'site-b')!;
    expect(siteB.hostPort).toBe(0); // 无显式端口按规格记 0

    const cd = await db.orm.select().from(appSettings).where(eq(appSettings.key, 'credential_db'));
    expect((cd[0]?.value as { host: string }).host).toBe('127.0.0.1');

    // 二次导入：label/baseUrl 变化被更新，行数不变
    const path2 = await writeRegistry(dir, 'Site A v2', 'http://127.0.0.1:8081');
    await importRegistry(db, path2);
    rows = await db.orm.select().from(sites).where(inArray(sites.slug, IMPORT_SLUGS));
    expect(rows).toHaveLength(2);
    const updated = rows.find((s) => s.slug === 'site-a')!;
    expect(updated.label).toBe('Site A v2');
    expect(updated.baseUrl).toBe('http://127.0.0.1:8081');
    expect(updated.hostPort).toBe(8080); // 冲突路径只更新 label/baseUrl/credentialRef
    expect(updated.managed).toBe('external');
  });

  it('无 root operator 时拒绝导入（独立空库）', async () => {
    const emptyDb = await makeDb('pglite:memory');
    try {
      await runMigrations(emptyDb);
      const dir = await freshTmpDir();
      const path = await writeRegistry(dir, 'Site A', 'http://127.0.0.1:8080');
      await expect(importRegistry(emptyDb, path)).rejects.toThrow(/root operator/);
    } finally {
      await emptyDb.close().catch(() => undefined);
    }
  });
});
