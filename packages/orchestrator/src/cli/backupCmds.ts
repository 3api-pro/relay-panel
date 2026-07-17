import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { and, asc, eq, ne } from 'drizzle-orm';
import { Sub2apiAdapter } from '@relay-panel/adapter-sub2api';
import { NewapiAdapter } from '@relay-panel/adapter-newapi';
import type { EngineKind, HealthReport, InstanceInfo } from '@relay-panel/adapter-core';
import { loadConfig, type Config } from '../config.js';
import { makeDb, runMigrations, type Db } from '../db/client.js';
import { operators, sites } from '../db/schema.js';
import { writeAudit } from '../audit.js';
import { ApiError } from '../auth/rbac.js';
import { dockerCompose, type ComposeRef } from '../provision/docker.js';

/**
 * 备份/恢复/接管子命令（规格 §10）：
 *   backup [--out <dir>]     — 编排器 DB（pg→pg_dump / pglite→目录拷贝）
 *                              + 每个 managed='compose' 且非 destroyed 站的引擎 PG dump
 *   restore --db <dump>      — 仅恢复编排器 DB（pg→psql / pglite→目录替换，须停机）
 *   adopt <slug> <baseUrl> --engine <e> --credential-ref <ref> [--label <l>] [--force]
 *                            — 外部存量站接管（managed='external'，凭据引用原样入库）
 * 纪律：清单/输出不含任何凭据；pg 连接口令走子进程环境变量，绝不上 argv（防进程列表泄露）。
 */

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 可注入依赖（单测用 fake，不起真容器/真子进程）
// ---------------------------------------------------------------------------

export interface BackupDeps {
  /** docker compose exec -T <service> <argv...> → stdout */
  composeExec(ref: ComposeRef, service: string, argv: string[]): Promise<string>;
  /** 本机子进程（pg_dump / psql）；env 为增量环境（叠加在 process.env 之上） */
  runCommand(cmd: string, argv: string[], env?: Record<string, string>): Promise<void>;
  /** 目录递归拷贝 */
  copyDir(src: string, dst: string): Promise<void>;
}

export const defaultBackupDeps: BackupDeps = {
  composeExec: (ref, service, argv) => dockerCompose.exec(ref, service, argv),
  runCommand: async (cmd, argv, env) => {
    await execFileAsync(cmd, argv, {
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
  },
  copyDir: (src, dst) => cp(src, dst, { recursive: true }),
};

// ---------------------------------------------------------------------------
// 纯函数：compose/.env 解析与命令材料构造（单测直接断言）
// ---------------------------------------------------------------------------

/** .env 文本 → 键值表（KEY=VALUE 每行一条；# 注释与空行忽略；值不去引号——生成器不写引号） */
export function parseEnvText(envText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

/** 解一层 ${VAR} / ${VAR:-def}（本面板生成的 compose 只用简单形态） */
function interpolate(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    return v !== undefined && v !== '' ? v : (def ?? '');
  });
}

export interface ComposePgInfo {
  /** compose 服务名（exec 目标） */
  service: string;
  user: string;
  dbName: string;
}

/**
 * 从站点 compose 文件里找 postgres 镜像的服务，返回 exec pg_dump 所需的服务名/用户/库名。
 * 只针对本面板生成的 compose 结构（两空格缩进、environment 列表形态）做轻量行解析，
 * 不引 YAML 依赖。找不到 postgres 服务（如 SQLite 形态引擎）返回 null。
 */
export function parseComposePg(composeText: string, envText: string): ComposePgInfo | null {
  const env = parseEnvText(envText);
  const lines = composeText.split(/\r?\n/);

  interface SvcInfo {
    image?: string;
    env: Record<string, string>;
  }
  const services = new Map<string, SvcInfo>();
  let inServices = false;
  let current: SvcInfo | null = null;

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    // 回到顶层其他 key（volumes:/networks: 等）即离开 services 块
    if (inServices && /^[A-Za-z_][^:]*:\s*$/.test(line) && !line.startsWith(' ')) {
      inServices = false;
      current = null;
      continue;
    }
    if (!inServices) continue;

    const svcMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (svcMatch) {
      current = { env: {} };
      services.set(svcMatch[1]!, current);
      continue;
    }
    if (!current) continue;

    const imgMatch = line.match(/^\s+image:\s*(\S+)\s*$/);
    if (imgMatch) {
      current.image = imgMatch[1]!;
      continue;
    }
    const envMatch = line.match(/^\s+-\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (envMatch) {
      current.env[envMatch[1]!] = envMatch[2]!;
    }
  }

  for (const [name, svc] of services) {
    const image = svc.image !== undefined ? interpolate(svc.image, env) : '';
    // 镜像形如 postgres:17-alpine 或 registry/postgres:tag
    if (!/(^|\/)postgres(:|$)/.test(image)) continue;
    const user = svc.env['POSTGRES_USER'] !== undefined ? interpolate(svc.env['POSTGRES_USER'], env) : 'postgres';
    const dbName = svc.env['POSTGRES_DB'] !== undefined ? interpolate(svc.env['POSTGRES_DB'], env) : user;
    return { service: name, user, dbName };
  }
  return null;
}

/** UTC 紧凑时间戳，做备份目录名：YYYYMMDD-HHMMSS */
export function formatBackupTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** postgres:// URL → libpq 环境变量（口令进 env 不进 argv） */
export function pgEnvFromUrl(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {};
  if (u.hostname !== '') env['PGHOST'] = decodeURIComponent(u.hostname);
  if (u.port !== '') env['PGPORT'] = u.port;
  if (u.username !== '') env['PGUSER'] = decodeURIComponent(u.username);
  if (u.password !== '') env['PGPASSWORD'] = decodeURIComponent(u.password);
  const dbName = u.pathname.replace(/^\//, '');
  if (dbName !== '') env['PGDATABASE'] = decodeURIComponent(dbName);
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode !== null && sslmode !== '') env['PGSSLMODE'] = sslmode;
  return env;
}

/** baseUrl 无显式端口记 0（external 站不参与端口池），语义同 registryImport */
function parseHostPort(baseUrl: string): number {
  try {
    const u = new URL(baseUrl);
    return u.port !== '' ? Number(u.port) : 0;
  } catch {
    return 0;
  }
}

/** 错误消息裁剪（备份清单用；来源为 fs/docker 错误，本身无凭据，仍限制长度防噪音） */
function briefError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

export interface SiteBackupEntry {
  slug: string;
  engine: string;
  status: 'ok' | 'skipped' | 'failed';
  /** 相对备份目录的文件名（status=ok 时） */
  file?: string;
  reason?: string;
}

export interface BackupManifest {
  createdAt: string;
  orchestratorDb: { kind: 'pg' | 'pglite'; target: string };
  sites: SiteBackupEntry[];
}

export interface BackupResult {
  /** 本次备份目录（<out>/<ts>） */
  dir: string;
  manifest: BackupManifest;
}

export async function performBackup(
  db: Db,
  config: Config,
  opts: { out?: string; now?: Date } = {},
  deps: BackupDeps = defaultBackupDeps,
): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const stamp = formatBackupTimestamp(now);
  const dir = resolve(opts.out ?? './data/backups', stamp);
  await mkdir(dir, { recursive: true });

  // 1) 编排器自身 DB
  let orchestratorDb: BackupManifest['orchestratorDb'];
  if (config.dbUrl.startsWith('postgres://') || config.dbUrl.startsWith('postgresql://')) {
    const file = 'orchestrator.sql';
    await deps.runCommand(
      'pg_dump',
      ['--no-owner', '--no-privileges', '--format=plain', '--file', join(dir, file)],
      pgEnvFromUrl(config.dbUrl),
    );
    orchestratorDb = { kind: 'pg', target: file };
  } else if (config.dbUrl.startsWith('pglite:')) {
    const src = config.dbUrl.slice('pglite:'.length);
    if (src === 'memory') throw new ApiError(400, 'pglite 内存库无法备份（仅测试用）');
    const target = 'orchestrator-db';
    await deps.copyDir(src, join(dir, target));
    orchestratorDb = { kind: 'pglite', target };
  } else {
    throw new ApiError(400, `无法识别的 RP_DB 形态，不支持备份: ${config.dbUrl.split(':')[0] ?? ''}`);
  }

  // 2) 各 managed compose 站的引擎 PG dump（容器内 pg_dump，本地 unix socket 无需口令）
  const rows = await db.orm
    .select({
      slug: sites.slug,
      engine: sites.engine,
      dataDir: sites.dataDir,
      composeProject: sites.composeProject,
    })
    .from(sites)
    .where(and(eq(sites.managed, 'compose'), ne(sites.status, 'destroyed')))
    .orderBy(asc(sites.slug));

  const entries: SiteBackupEntry[] = [];
  for (const row of rows) {
    const dataDir = row.dataDir !== '' ? row.dataDir : join(config.sitesRoot, row.slug);
    const composeFile = join(dataDir, 'docker-compose.yml');
    const envFile = join(dataDir, '.env');
    try {
      let composeText: string;
      let envText: string;
      try {
        composeText = await readFile(composeFile, 'utf8');
        envText = await readFile(envFile, 'utf8');
      } catch {
        entries.push({
          slug: row.slug,
          engine: row.engine,
          status: 'failed',
          reason: '站点目录缺少 docker-compose.yml / .env',
        });
        continue;
      }
      const pg = parseComposePg(composeText, envText);
      if (pg === null) {
        entries.push({
          slug: row.slug,
          engine: row.engine,
          status: 'skipped',
          reason: '引擎 compose 无 postgres 服务（数据在容器卷中，随站点卷备份）',
        });
        continue;
      }
      const ref: ComposeRef = {
        project: row.composeProject !== '' ? row.composeProject : `rp-${row.slug}`,
        file: composeFile,
        envFile,
      };
      const sql = await deps.composeExec(ref, pg.service, [
        'pg_dump',
        '-U',
        pg.user,
        '--no-owner',
        '--no-privileges',
        pg.dbName,
      ]);
      const file = `site-${row.slug}.sql`;
      await writeFile(join(dir, file), sql, 'utf8');
      entries.push({ slug: row.slug, engine: row.engine, status: 'ok', file });
    } catch (err) {
      entries.push({ slug: row.slug, engine: row.engine, status: 'failed', reason: briefError(err) });
    }
  }

  // 3) 清单（绝不含凭据：只有 slug/engine/文件名/原因）
  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    orchestratorDb,
    sites: entries,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  await writeAudit(db, {
    actor: 'cli',
    action: 'backup.run',
    payload: {
      stamp,
      ok: entries.filter((e) => e.status === 'ok').length,
      skipped: entries.filter((e) => e.status === 'skipped').length,
      failed: entries.filter((e) => e.status === 'failed').length,
    },
    ok: true,
  });

  return { dir, manifest };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export async function performRestore(
  config: Config,
  dumpPath: string,
  opts: { now?: Date } = {},
  deps: BackupDeps = defaultBackupDeps,
): Promise<{ kind: 'pg' | 'pglite'; detail: string }> {
  if (config.dbUrl.startsWith('postgres://') || config.dbUrl.startsWith('postgresql://')) {
    const st = await stat(dumpPath).catch(() => null);
    if (st === null || !st.isFile()) {
      throw new ApiError(400, `pg 恢复需要传入 pg_dump 产出的 SQL 文件: ${dumpPath}`);
    }
    // 明文 dump 直接 psql 导入；目标库须为空库（含既有表会冲突报错并停止）
    await deps.runCommand(
      'psql',
      ['--set', 'ON_ERROR_STOP=1', '--file', dumpPath],
      pgEnvFromUrl(config.dbUrl),
    );
    return { kind: 'pg', detail: `已导入 ${basename(dumpPath)}（目标库须为空库）` };
  }

  if (config.dbUrl.startsWith('pglite:')) {
    const target = config.dbUrl.slice('pglite:'.length);
    if (target === 'memory') throw new ApiError(400, 'pglite 内存库无需恢复（仅测试用）');
    const st = await stat(dumpPath).catch(() => null);
    if (st === null || !st.isDirectory()) {
      throw new ApiError(400, `pglite 恢复需要传入备份产出的数据目录（orchestrator-db）: ${dumpPath}`);
    }
    // 停机检查：数据目录仍被占用（编排器在跑）时拒绝替换
    if (existsSync(join(target, 'postmaster.pid'))) {
      throw new ApiError(409, '目标数据目录存在 postmaster.pid，编排器可能仍在运行；请先停机再恢复');
    }
    let rollbackDir: string | null = null;
    if (existsSync(target)) {
      rollbackDir = `${target}.pre-restore-${formatBackupTimestamp(opts.now ?? new Date())}`;
      try {
        await rename(target, rollbackDir);
      } catch {
        // Windows 上文件被占用时 rename 失败 —— 等价于锁检测
        throw new ApiError(409, '目标数据目录被占用（重命名失败），请先停止编排器服务再恢复');
      }
    }
    await deps.copyDir(dumpPath, target);
    return {
      kind: 'pglite',
      detail:
        rollbackDir !== null
          ? `目录已替换；原数据保留在 ${rollbackDir}（确认无误后可删除）`
          : '目录已就位（原目录不存在，无需备份旧数据）',
    };
  }

  throw new ApiError(400, `无法识别的 RP_DB 形态，不支持恢复: ${config.dbUrl.split(':')[0] ?? ''}`);
}

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------

export interface AdoptArgs {
  slug: string;
  baseUrl: string;
  engine: EngineKind;
  credentialRef: string;
  label?: string;
  /** 健康探测失败仍强制入库 */
  force?: boolean;
}

export interface AdoptDeps {
  probeHealth(engine: EngineKind, inst: InstanceInfo): Promise<HealthReport>;
}

export const defaultAdoptDeps: AdoptDeps = {
  probeHealth: (engine, inst) =>
    (engine === 'sub2api' ? new Sub2apiAdapter() : new NewapiAdapter()).health(inst),
};

export async function performAdopt(
  db: Db,
  args: AdoptArgs,
  deps: AdoptDeps = defaultAdoptDeps,
): Promise<{ siteId: number; health: HealthReport }> {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(args.slug)) {
    throw new ApiError(400, `slug 无效（^[a-z0-9][a-z0-9-]{1,31}$）: ${args.slug}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(args.baseUrl);
  } catch {
    throw new ApiError(400, `baseUrl 无效: ${args.baseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'baseUrl 必须是 http/https 地址');
  }
  if (args.credentialRef === '') throw new ApiError(400, '--credential-ref 不能为空');

  const dup = await db.orm.select({ id: sites.id }).from(sites).where(eq(sites.slug, args.slug)).limit(1);
  if (dup.length > 0) throw new ApiError(409, `站点已存在: ${args.slug}`);

  const roots = await db.orm
    .select({ id: operators.id })
    .from(operators)
    .where(eq(operators.role, 'root'))
    .orderBy(asc(operators.id))
    .limit(1);
  const root = roots[0];
  if (!root) throw new ApiError(400, '尚无 root 操作员，请先运行 create-admin');

  // 健康探测（可达性回显）；探测异常按不可达处理，--force 可强制入库
  const inst: InstanceInfo = {
    siteSlug: args.slug,
    engine: args.engine,
    version: 'prod',
    baseUrl: args.baseUrl,
    dataDir: '',
    composeProject: '',
    credentialRef: args.credentialRef,
  };
  let health: HealthReport;
  try {
    health = await deps.probeHealth(args.engine, inst);
  } catch (err) {
    health = { ok: false, httpOk: false, detail: briefError(err) };
  }
  if (!health.ok && args.force !== true) {
    throw new ApiError(
      409,
      `健康探测未通过（${health.detail ?? `httpOk=${health.httpOk}`}）；确认无误可加 --force 强制入库`,
    );
  }

  const inserted = await db.orm
    .insert(sites)
    .values({
      operatorId: root.id,
      slug: args.slug,
      label: args.label ?? args.slug,
      engine: args.engine,
      version: 'prod', // 存量站版本未知，沿用 registry 导入的占位语义
      hostPort: parseHostPort(args.baseUrl),
      baseUrl: args.baseUrl,
      credentialRef: args.credentialRef,
      managed: 'external',
      status: 'active',
    })
    .returning({ id: sites.id });
  const siteId = inserted[0]!.id;

  await writeAudit(db, {
    siteId,
    actor: 'cli',
    action: 'site.adopt',
    // 凭据引用不进审计 payload（含敏感词也会被 redact，干脆不放）
    payload: {
      slug: args.slug,
      baseUrl: args.baseUrl,
      engine: args.engine,
      label: args.label ?? args.slug,
      healthOk: health.ok,
      forced: args.force === true,
    },
    ok: true,
  });

  return { siteId, health };
}

// ---------------------------------------------------------------------------
// CLI 装配
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--engine', '--credential-ref', '--label', '--out', '--db']);

function parseCliArgs(rest: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) {
        const v = rest[i + 1];
        if (v === undefined) throw new ApiError(400, `${a} 缺少取值`);
        flags[a.slice(2)] = v;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function cmdBackup(rest: string[]): Promise<number> {
  const { flags } = parseCliArgs(rest);
  const config = loadConfig();
  // 注意：pglite 模式下 CLI 与服务进程不能同时打开同一数据目录，建议停机后备份
  const db = await makeDb(config.dbUrl);
  try {
    const out = typeof flags['out'] === 'string' ? flags['out'] : undefined;
    const result = await performBackup(db, config, out !== undefined ? { out } : {});
    console.log(`备份完成: ${result.dir}`);
    console.log(`  编排器 DB: ${result.manifest.orchestratorDb.kind} → ${result.manifest.orchestratorDb.target}`);
    for (const e of result.manifest.sites) {
      const tail = e.status === 'ok' ? e.file : e.reason;
      console.log(`  站点 ${e.slug} [${e.engine}]: ${e.status}${tail !== undefined ? ` — ${tail}` : ''}`);
    }
    const failed = result.manifest.sites.filter((e) => e.status === 'failed').length;
    return failed > 0 ? 1 : 0;
  } finally {
    await db.close().catch(() => undefined);
  }
}

async function cmdRestore(rest: string[]): Promise<number> {
  const { flags } = parseCliArgs(rest);
  const dump = flags['db'];
  if (typeof dump !== 'string') {
    console.error('restore: 缺少 --db <dump>');
    return 1;
  }
  const config = loadConfig();
  const result = await performRestore(config, dump);
  console.log(`恢复完成 (${result.kind}): ${result.detail}`);
  console.log('站点级数据恢复流程见 docs/OPERATIONS.md');
  // 尽力而为：往恢复后的库补一条审计（失败不影响恢复结果）
  try {
    const db = await makeDb(config.dbUrl);
    try {
      await writeAudit(db, {
        actor: 'cli',
        action: 'db.restore',
        payload: { kind: result.kind, source: basename(dump) },
        ok: true,
      });
    } finally {
      await db.close().catch(() => undefined);
    }
  } catch {
    console.warn('恢复成功，但写入审计事件失败（可忽略）');
  }
  return 0;
}

async function cmdAdopt(rest: string[]): Promise<number> {
  const { positional, flags } = parseCliArgs(rest);
  const [slug, baseUrl] = positional;
  const engine = flags['engine'];
  const credentialRef = flags['credential-ref'];
  if (slug === undefined || baseUrl === undefined || typeof engine !== 'string' || typeof credentialRef !== 'string') {
    console.error('adopt: 用法 adopt <slug> <baseUrl> --engine <sub2api|newapi> --credential-ref <ref> [--label <label>] [--force]');
    return 1;
  }
  if (engine !== 'sub2api' && engine !== 'newapi') {
    console.error(`adopt: 不支持的引擎: ${engine}`);
    return 1;
  }
  const config = loadConfig();
  const db = await makeDb(config.dbUrl);
  try {
    await runMigrations(db);
    const label = typeof flags['label'] === 'string' ? flags['label'] : undefined;
    const result = await performAdopt(db, {
      slug,
      baseUrl,
      engine,
      credentialRef,
      ...(label !== undefined ? { label } : {}),
      ...(flags['force'] === true ? { force: true } : {}),
    });
    const h = result.health;
    console.log(
      `健康探测: ok=${h.ok} httpOk=${h.httpOk}${h.latencyMs !== undefined ? ` latencyMs=${h.latencyMs}` : ''}${h.version !== undefined ? ` version=${h.version}` : ''}${h.detail !== undefined ? ` detail=${h.detail}` : ''}`,
    );
    console.log(`已接管站点: ${slug} (id=${result.siteId}, managed=external)`);
    return 0;
  } finally {
    await db.close().catch(() => undefined);
  }
}

export async function runBackupCommand(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'backup') return await cmdBackup(rest);
    if (cmd === 'restore') return await cmdRestore(rest);
    if (cmd === 'adopt') return await cmdAdopt(rest);
  } catch (err) {
    console.error(`${cmd}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.log(
    'usage: backup [--out <dir>] | restore --db <dump> | adopt <slug> <baseUrl> --engine <e> --credential-ref <ref> [--label <label>] [--force]',
  );
  return 1;
}
