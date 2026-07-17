import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ComposeRef } from '../src/provision/docker.js';
import { renderSub2apiCompose, renderSub2apiEnv } from '../src/provision/sub2apiCompose.js';
import { renderNewapiCompose, renderNewapiEnv } from '../src/provision/newapiCompose.js';
import { auditEvents, sites } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { makeTestConfig, makeTestDb, seedOperator } from './helpers.js';
import {
  formatBackupTimestamp,
  parseComposePg,
  parseEnvText,
  performAdopt,
  performBackup,
  performRestore,
  pgEnvFromUrl,
  type BackupDeps,
} from '../src/cli/backupCmds.js';

vi.setConfig({ testTimeout: 30_000 });

/**
 * G5 单元测试（规格 §10）：备份路径/清单组装与命令构造全部经可注入 fake 断言，
 * 不起真容器、不跑真 pg_dump/psql。凭据类值一律用显眼的占位串并断言不落清单。
 */

// ---- 可注入 fake deps ---------------------------------------------------

interface DepsCalls {
  composeExec: { ref: ComposeRef; service: string; argv: string[] }[];
  runCommand: { cmd: string; argv: string[]; env: Record<string, string> | undefined }[];
  copyDir: { src: string; dst: string }[];
}

function makeFakeDeps(): { deps: BackupDeps; calls: DepsCalls } {
  const calls: DepsCalls = { composeExec: [], runCommand: [], copyDir: [] };
  const deps: BackupDeps = {
    composeExec: async (ref, service, argv) => {
      calls.composeExec.push({ ref, service, argv });
      return '-- fake dump\n';
    },
    runCommand: async (cmd, argv, env) => {
      calls.runCommand.push({ cmd, argv, env });
    },
    copyDir: async (src, dst) => {
      calls.copyDir.push({ src, dst });
      await mkdir(dst, { recursive: true });
    },
  };
  return { deps, calls };
}

// ---- 共享 fixture（pglite 冷启动贵：整文件一个 db） -----------------------

let db: Db;
let operatorId: number;
let sitesRoot: string;
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  db = await makeTestDb();
  operatorId = await seedOperator(db, { email: 'root@example.com', role: 'root' });

  // 站点目录：site-a=sub2api（有 postgres 服务），site-b=newapi（无 postgres 服务）
  sitesRoot = await tempDir('rp-backup-sites-');
  await mkdir(join(sitesRoot, 'site-a'), { recursive: true });
  const subInput = {
    slug: 'site-a',
    version: '0.0.1',
    hostPort: 18100,
    adminEmail: 'admin@example.com',
    postgresPassword: 'unit-test-secret-pg',
    jwtSecret: 'unit-test-secret-jwt',
    totpEncryptionKey: 'unit-test-secret-totp',
    adminPassword: 'unit-test-secret-admin',
  };
  await writeFile(join(sitesRoot, 'site-a', '.env'), renderSub2apiEnv(subInput), 'utf8');
  await writeFile(join(sitesRoot, 'site-a', 'docker-compose.yml'), renderSub2apiCompose(subInput), 'utf8');

  await mkdir(join(sitesRoot, 'site-b'), { recursive: true });
  const newInput = {
    slug: 'site-b',
    version: '0.0.1',
    hostPort: 18101,
    sessionSecret: 'unit-test-secret-sess',
  };
  await writeFile(join(sitesRoot, 'site-b', '.env'), renderNewapiEnv(newInput), 'utf8');
  await writeFile(join(sitesRoot, 'site-b', 'docker-compose.yml'), renderNewapiCompose(newInput), 'utf8');

  const base = {
    operatorId,
    version: '0.0.1',
    domains: [] as string[],
    baseUrl: 'http://127.0.0.1:0',
  };
  await db.orm.insert(sites).values([
    // dataDir/composeProject 留空 → 走 sitesRoot/slug 与 rp-<slug> 回退
    { ...base, slug: 'site-a', label: 'A', engine: 'sub2api', hostPort: 18100, managed: 'compose', status: 'active' },
    {
      ...base,
      slug: 'site-b',
      label: 'B',
      engine: 'newapi',
      hostPort: 18101,
      managed: 'compose',
      status: 'active',
      dataDir: join(sitesRoot, 'site-b'),
      composeProject: 'rp-site-b',
    },
    // external 与 destroyed 均不参与备份
    { ...base, slug: 'site-c', label: 'C', engine: 'sub2api', hostPort: 0, managed: 'external', status: 'active' },
    { ...base, slug: 'site-d', label: 'D', engine: 'sub2api', hostPort: 18102, managed: 'compose', status: 'destroyed' },
  ]);
});

afterAll(async () => {
  await db.close().catch(() => undefined);
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

// ---- 纯函数 --------------------------------------------------------------

describe('parseEnvText / parseComposePg', () => {
  it('从 sub2api 生成的 compose 里解析出 postgres 服务/用户/库名', () => {
    const input = {
      slug: 'site-x',
      version: '0.0.1',
      hostPort: 18110,
      adminEmail: 'admin@example.com',
      postgresPassword: 'example-pg-pass',
      jwtSecret: 'example-jwt',
      totpEncryptionKey: 'example-totp',
      adminPassword: 'example-admin',
    };
    const pg = parseComposePg(renderSub2apiCompose(input), renderSub2apiEnv(input));
    expect(pg).toEqual({ service: 'postgres', user: 'sub2api', dbName: 'sub2api' });
  });

  it('newapi 生成的 compose 无 postgres 服务 → null', () => {
    const input = { slug: 'site-y', version: '0.0.1', hostPort: 18111, sessionSecret: 'example-sess' };
    expect(parseComposePg(renderNewapiCompose(input), renderNewapiEnv(input))).toBeNull();
  });

  it('POSTGRES_USER/POSTGRES_DB 支持 ${VAR} 引用 .env；缺 POSTGRES_DB 时回退用户名', () => {
    const compose = [
      'services:',
      '  db:',
      '    image: postgres:17-alpine',
      '    environment:',
      // eslint-disable-next-line no-template-curly-in-string
      '      - POSTGRES_USER=${PG_USER}',
      'volumes:',
      '  db_data:',
    ].join('\n');
    const pg = parseComposePg(compose, 'PG_USER=alice\n');
    expect(pg).toEqual({ service: 'db', user: 'alice', dbName: 'alice' });
  });

  it('parseEnvText 忽略注释/空行，值含等号也完整保留', () => {
    expect(parseEnvText('# c\n\nA=1\nB=x=y\n')).toEqual({ A: '1', B: 'x=y' });
  });
});

describe('formatBackupTimestamp / pgEnvFromUrl', () => {
  it('UTC 紧凑时间戳', () => {
    expect(formatBackupTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('20260102-030405');
  });

  it('postgres URL → libpq 环境变量（口令进 env，不进 argv）', () => {
    const env = pgEnvFromUrl('postgres://rp:example-pass@db.example.com:5433/rpdb?sslmode=require');
    expect(env).toEqual({
      PGHOST: 'db.example.com',
      PGPORT: '5433',
      PGUSER: 'rp',
      PGPASSWORD: 'example-pass',
      PGDATABASE: 'rpdb',
      PGSSLMODE: 'require',
    });
  });

  it('无口令/无端口的 URL 不产出对应变量', () => {
    const env = pgEnvFromUrl('postgres://db.example.com/rpdb');
    expect(env).toEqual({ PGHOST: 'db.example.com', PGDATABASE: 'rpdb' });
  });
});

// ---- performBackup -------------------------------------------------------

describe('performBackup', () => {
  it('pglite 编排器库 + compose 站 pg_dump：目录/清单/命令构造正确且清单无凭据', async () => {
    const orchDir = await tempDir('rp-backup-orch-');
    await writeFile(join(orchDir, 'marker.bin'), 'x', 'utf8');
    const out = await tempDir('rp-backup-out-');
    const { deps, calls } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: `pglite:${orchDir}`, sitesRoot });

    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    const result = await performBackup(db, config, { out, now }, deps);

    // 备份目录 = <out>/<ts>
    expect(result.dir).toBe(join(out, '20260102-030405'));

    // 编排器库：pglite → 目录拷贝
    expect(calls.copyDir).toEqual([{ src: orchDir, dst: join(result.dir, 'orchestrator-db') }]);
    expect(calls.runCommand).toEqual([]);

    // 站点 dump：只有 site-a（sub2api）；service/用户/库名来自 compose+env；project 回退 rp-<slug>
    expect(calls.composeExec).toHaveLength(1);
    const call = calls.composeExec[0]!;
    expect(call.service).toBe('postgres');
    expect(call.argv).toEqual(['pg_dump', '-U', 'sub2api', '--no-owner', '--no-privileges', 'sub2api']);
    expect(call.ref.project).toBe('rp-site-a');
    expect(call.ref.file).toBe(join(sitesRoot, 'site-a', 'docker-compose.yml'));
    expect(call.ref.envFile).toBe(join(sitesRoot, 'site-a', '.env'));

    // dump 落盘
    expect(await readFile(join(result.dir, 'site-site-a.sql'), 'utf8')).toBe('-- fake dump\n');

    // 清单：site-a ok / site-b skipped；external与destroyed不出现；不含任何凭据占位串
    const manifestRaw = await readFile(join(result.dir, 'manifest.json'), 'utf8');
    expect(manifestRaw).not.toContain('unit-test-secret');
    const manifest = JSON.parse(manifestRaw) as typeof result.manifest;
    expect(manifest.orchestratorDb).toEqual({ kind: 'pglite', target: 'orchestrator-db' });
    expect(manifest.sites).toEqual([
      { slug: 'site-a', engine: 'sub2api', status: 'ok', file: 'site-site-a.sql' },
      {
        slug: 'site-b',
        engine: 'newapi',
        status: 'skipped',
        reason: '引擎 compose 无 postgres 服务（数据在容器卷中，随站点卷备份）',
      },
    ]);

    // 审计落库
    const audits = await db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'backup.run'));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[audits.length - 1]!.ok).toBe(true);
  });

  it('pg 编排器库：pg_dump 命令构造，口令只在 env 不在 argv', async () => {
    const out = await tempDir('rp-backup-out-pg-');
    const { deps, calls } = makeFakeDeps();
    const config = makeTestConfig({
      dbUrl: 'postgres://rp:example-pass@127.0.0.1:5432/rpdb',
      sitesRoot,
    });

    const result = await performBackup(db, config, { out, now: new Date(Date.UTC(2026, 5, 6, 7, 8, 9)) }, deps);

    expect(result.manifest.orchestratorDb).toEqual({ kind: 'pg', target: 'orchestrator.sql' });
    expect(calls.copyDir).toEqual([]);
    expect(calls.runCommand).toHaveLength(1);
    const rc = calls.runCommand[0]!;
    expect(rc.cmd).toBe('pg_dump');
    expect(rc.argv).toEqual([
      '--no-owner',
      '--no-privileges',
      '--format=plain',
      '--file',
      join(result.dir, 'orchestrator.sql'),
    ]);
    expect(rc.argv.join(' ')).not.toContain('example-pass');
    expect(rc.env?.['PGPASSWORD']).toBe('example-pass');
    expect(rc.env?.['PGDATABASE']).toBe('rpdb');
  });

  it('pglite:memory 拒绝备份', async () => {
    const { deps } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: 'pglite:memory', sitesRoot });
    await expect(performBackup(db, config, {}, deps)).rejects.toThrow(/内存库/);
  });

  it('站点目录缺 compose/.env → 该站 failed，整体不中断', async () => {
    const out = await tempDir('rp-backup-out-miss-');
    const emptyRoot = await tempDir('rp-backup-empty-root-');
    const orchDir = await tempDir('rp-backup-orch2-');
    const { deps, calls } = makeFakeDeps();
    // sitesRoot 指到空目录：site-a/site-b 的目录都不存在
    const config = makeTestConfig({ dbUrl: `pglite:${orchDir}`, sitesRoot: emptyRoot });

    const result = await performBackup(db, config, { out }, deps);
    expect(calls.composeExec).toEqual([]);
    // site-a 缺目录 failed；site-b dataDir 显式指向真实目录 → 仍 skipped
    expect(result.manifest.sites).toEqual([
      { slug: 'site-a', engine: 'sub2api', status: 'failed', reason: '站点目录缺少 docker-compose.yml / .env' },
      {
        slug: 'site-b',
        engine: 'newapi',
        status: 'skipped',
        reason: '引擎 compose 无 postgres 服务（数据在容器卷中，随站点卷备份）',
      },
    ]);
  });
});

// ---- performRestore ------------------------------------------------------

describe('performRestore', () => {
  it('pg：psql 导入命令构造，口令只在 env', async () => {
    const dumpDir = await tempDir('rp-restore-pg-');
    const dumpFile = join(dumpDir, 'orchestrator.sql');
    await writeFile(dumpFile, '-- dump', 'utf8');
    const { deps, calls } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: 'postgres://rp:example-pass@127.0.0.1:5432/rpdb' });

    const result = await performRestore(config, dumpFile, {}, deps);
    expect(result.kind).toBe('pg');
    expect(calls.runCommand).toHaveLength(1);
    const rc = calls.runCommand[0]!;
    expect(rc.cmd).toBe('psql');
    expect(rc.argv).toEqual(['--set', 'ON_ERROR_STOP=1', '--file', dumpFile]);
    expect(rc.argv.join(' ')).not.toContain('example-pass');
    expect(rc.env?.['PGPASSWORD']).toBe('example-pass');
  });

  it('pg：dump 路径不是文件 → 拒绝', async () => {
    const dumpDir = await tempDir('rp-restore-pg-dir-');
    const { deps } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: 'postgres://rp:example-pass@127.0.0.1:5432/rpdb' });
    await expect(performRestore(config, dumpDir, {}, deps)).rejects.toThrow(/SQL 文件/);
  });

  it('pglite：postmaster.pid 存在（疑似在跑）→ 拒绝替换', async () => {
    const dump = await tempDir('rp-restore-dump-');
    const dataRoot = await tempDir('rp-restore-data-');
    const target = join(dataRoot, 'orchestrator-db');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'postmaster.pid'), '123', 'utf8');
    const { deps } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: `pglite:${target}` });
    await expect(performRestore(config, dump, {}, deps)).rejects.toThrow(/postmaster\.pid|停机/);
  });

  it('pglite：旧目录改名保底后目录替换', async () => {
    const dump = await tempDir('rp-restore-dump2-');
    await writeFile(join(dump, 'marker.bin'), 'new', 'utf8');
    const dataRoot = await tempDir('rp-restore-data2-');
    const target = join(dataRoot, 'orchestrator-db');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'old-data.bin'), 'old', 'utf8');
    const { deps, calls } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: `pglite:${target}` });

    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    const result = await performRestore(config, dump, { now }, deps);
    expect(result.kind).toBe('pglite');
    // 旧目录整体挪到 .pre-restore-<ts>，内容保留
    expect(existsSync(join(`${target}.pre-restore-20260102-030405`, 'old-data.bin'))).toBe(true);
    expect(calls.copyDir).toEqual([{ src: dump, dst: target }]);
  });

  it('pglite：目标目录不存在时直接就位，不做改名', async () => {
    const dump = await tempDir('rp-restore-dump3-');
    const dataRoot = await tempDir('rp-restore-data3-');
    const target = join(dataRoot, 'orchestrator-db');
    const { deps, calls } = makeFakeDeps();
    const config = makeTestConfig({ dbUrl: `pglite:${target}` });
    const result = await performRestore(config, dump, {}, deps);
    expect(result.detail).toContain('原目录不存在');
    expect(calls.copyDir).toEqual([{ src: dump, dst: target }]);
  });

  it('pglite：dump 不是目录 → 拒绝；pglite:memory → 拒绝', async () => {
    const dumpDir = await tempDir('rp-restore-file-');
    const file = join(dumpDir, 'x.sql');
    await writeFile(file, '-- x', 'utf8');
    const { deps } = makeFakeDeps();
    await expect(
      performRestore(makeTestConfig({ dbUrl: `pglite:${join(dumpDir, 'db')}` }), file, {}, deps),
    ).rejects.toThrow(/数据目录/);
    await expect(performRestore(makeTestConfig({ dbUrl: 'pglite:memory' }), dumpDir, {}, deps)).rejects.toThrow(
      /内存库/,
    );
  });
});

// ---- performAdopt --------------------------------------------------------

describe('performAdopt', () => {
  const okHealth = { ok: true, httpOk: true, latencyMs: 12, version: '1.0.0' };

  it('探测通过 → external 入库，凭据引用原样保存，审计不含凭据引用', async () => {
    const probes: { engine: string; baseUrl: string }[] = [];
    const result = await performAdopt(
      db,
      { slug: 'adopt-a', baseUrl: 'http://site-a.example.com:8080', engine: 'sub2api', credentialRef: 'db:adopt-a' },
      {
        probeHealth: async (engine, inst) => {
          probes.push({ engine, baseUrl: inst.baseUrl });
          return okHealth;
        },
      },
    );
    expect(result.health.ok).toBe(true);
    expect(probes).toEqual([{ engine: 'sub2api', baseUrl: 'http://site-a.example.com:8080' }]);

    const row = (await db.orm.select().from(sites).where(eq(sites.slug, 'adopt-a')))[0]!;
    expect(row.managed).toBe('external');
    expect(row.status).toBe('active');
    expect(row.version).toBe('prod');
    expect(row.hostPort).toBe(8080);
    expect(row.credentialRef).toBe('db:adopt-a');
    expect(row.operatorId).toBe(operatorId);

    const audit = (await db.orm.select().from(auditEvents).where(eq(auditEvents.action, 'site.adopt')))[0]!;
    expect(audit.ok).toBe(true);
    expect(audit.siteId).toBe(result.siteId);
    const payload = audit.payload as Record<string, unknown>;
    expect(payload['slug']).toBe('adopt-a');
    expect(payload['healthOk']).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('db:adopt-a');
  });

  it('探测失败且未 --force → 拒绝且不入库', async () => {
    await expect(
      performAdopt(
        db,
        { slug: 'adopt-b', baseUrl: 'http://site-b.example.com', engine: 'newapi', credentialRef: 'db:adopt-b' },
        { probeHealth: async () => ({ ok: false, httpOk: false, detail: 'connect timeout' }) },
      ),
    ).rejects.toThrow(/--force/);
    expect(await db.orm.select().from(sites).where(eq(sites.slug, 'adopt-b'))).toHaveLength(0);
  });

  it('探测抛异常按不可达处理；--force 仍可强制入库', async () => {
    const result = await performAdopt(
      db,
      {
        slug: 'adopt-c',
        baseUrl: 'https://site-c.example.com',
        engine: 'newapi',
        credentialRef: 'db:adopt-c',
        force: true,
      },
      {
        probeHealth: async () => {
          throw new Error('boom');
        },
      },
    );
    expect(result.health.ok).toBe(false);
    const row = (await db.orm.select().from(sites).where(eq(sites.slug, 'adopt-c')))[0]!;
    expect(row.managed).toBe('external');
    // https 无显式端口 → hostPort=0
    expect(row.hostPort).toBe(0);
  });

  it('slug 重复 → 409；slug 非法 / baseUrl 非法 / 凭据引用为空 → 400', async () => {
    const deps = { probeHealth: async () => okHealth };
    await expect(
      performAdopt(db, { slug: 'adopt-a', baseUrl: 'http://x.example.com', engine: 'sub2api', credentialRef: 'db:x' }, deps),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      performAdopt(db, { slug: 'BAD_SLUG', baseUrl: 'http://x.example.com', engine: 'sub2api', credentialRef: 'db:x' }, deps),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      performAdopt(db, { slug: 'adopt-e', baseUrl: 'not-a-url', engine: 'sub2api', credentialRef: 'db:x' }, deps),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      performAdopt(db, { slug: 'adopt-f', baseUrl: 'ftp://x.example.com', engine: 'sub2api', credentialRef: 'db:x' }, deps),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      performAdopt(db, { slug: 'adopt-g', baseUrl: 'http://x.example.com', engine: 'sub2api', credentialRef: '' }, deps),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
