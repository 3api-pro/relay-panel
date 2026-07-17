import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineLifecycle, InstanceInfo, SiteSpec } from '@relay-panel/adapter-core';
import { dockerCompose, type ComposeRef } from './docker.js';
import { renderNewapiCompose, renderNewapiEnv, type NewapiComposeInput } from './newapiCompose.js';
import { randomPassword } from './secrets.js';

export interface NewapiLifecycleOptions {
  sitesRoot: string;
  /** 生成的凭据交给上层加密入库；返回 credentialRef。new-api 用 root 用户名+密码。 */
  storeCredential: (
    slug: string,
    secrets: { adminUsername: string; adminPassword: string },
  ) => Promise<string>;
  onStep?: (slug: string, step: string, status: 'start' | 'ok' | 'fail', detail?: string) => Promise<void>;
}

function composeRef(sitesRoot: string, slug: string): ComposeRef {
  const dir = join(sitesRoot, slug);
  return { project: `rp-${slug}`, file: join(dir, 'docker-compose.yml'), envFile: join(dir, '.env') };
}

/** new-api 健康检查是 GET /api/status → {success:true}（与 sub2api 的 /health 不同） */
async function waitHealthy(baseUrl: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { success?: boolean };
        if (j.success === true) return;
        lastErr = 'status.success != true';
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`health check timeout: ${lastErr}`);
}

/** new-api 首启无预置 admin，须 POST /api/setup 建 root（幂等：已初始化则跳过） */
async function ensureRoot(baseUrl: string, username: string, password: string): Promise<void> {
  const st = (await fetch(`${baseUrl}/api/setup`, { signal: AbortSignal.timeout(8000) }).then((r) =>
    r.json(),
  )) as { data?: { root_init?: boolean } };
  if (st.data?.root_init) return; // 已建过 root
  const res = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      confirmPassword: password,
      SelfUseModeEnabled: false,
      DemoSiteEnabled: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (j.success === false) throw new Error(`setup root failed: ${j.message ?? 'unknown'}`);
}

export class NewapiLifecycle implements EngineLifecycle {
  readonly engine = 'newapi' as const;

  constructor(private readonly opts: NewapiLifecycleOptions) {}

  private async step<T>(slug: string, name: string, fn: () => Promise<T>): Promise<T> {
    await this.opts.onStep?.(slug, name, 'start');
    try {
      const out = await fn();
      await this.opts.onStep?.(slug, name, 'ok');
      return out;
    } catch (e) {
      await this.opts.onStep?.(slug, name, 'fail', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async provision(spec: SiteSpec): Promise<InstanceInfo> {
    if (spec.engine !== 'newapi') throw new Error(`wrong engine: ${spec.engine}`);
    const dir = join(this.opts.sitesRoot, spec.slug);
    const ref = composeRef(this.opts.sitesRoot, spec.slug);
    const baseUrl = `http://127.0.0.1:${spec.hostPort}`;
    // new-api 的 admin "用户名"承载在 adminEmail 字段（引擎用 username 登录）
    const adminUsername = spec.adminEmail.includes('@') ? spec.adminEmail.split('@')[0]! : spec.adminEmail;

    const secrets = await this.step(spec.slug, 'render', async () => {
      await mkdir(dir, { recursive: true });
      let existing: string | null = null;
      try {
        existing = await readFile(ref.envFile, 'utf8');
      } catch {
        /* first run */
      }
      const s: NewapiComposeInput & { adminPassword: string } = existing
        ? { ...reuseEnv(existing, spec), adminPassword: getEnv(existing, 'ADMIN_PASSWORD') || randomPassword() }
        : {
            slug: spec.slug,
            version: spec.version,
            hostPort: spec.hostPort,
            sessionSecret: randomPassword(40),
            ...(spec.database.mode === 'shared' && spec.database.serverDsn
              ? { sqlDsn: buildSqlDsn(spec) }
              : {}),
            adminPassword: randomPassword(),
          };
      // ADMIN_PASSWORD 也落 .env 供幂等重入复用（不进引擎 env，仅供 provisioner）
      await writeFile(ref.envFile, renderNewapiEnv(s) + `ADMIN_PASSWORD=${s.adminPassword}\n`, 'utf8');
      await writeFile(ref.file, renderNewapiCompose(s), 'utf8');
      return s;
    });

    await this.step(spec.slug, 'compose-up', () => dockerCompose.up(ref));
    await this.step(spec.slug, 'health', () => waitHealthy(baseUrl));
    await this.step(spec.slug, 'init-root', () => ensureRoot(baseUrl, adminUsername, secrets.adminPassword));

    const credentialRef = await this.step(spec.slug, 'store-credential', () =>
      this.opts.storeCredential(spec.slug, { adminUsername, adminPassword: secrets.adminPassword }),
    );

    return {
      siteSlug: spec.slug,
      engine: 'newapi',
      version: spec.version,
      baseUrl,
      dataDir: dir,
      composeProject: ref.project,
      credentialRef,
    };
  }

  async upgrade(inst: InstanceInfo, toVersion: string): Promise<InstanceInfo> {
    if (toVersion === 'latest') throw new Error('version must be pinned');
    const ref = composeRef(this.opts.sitesRoot, inst.siteSlug);
    const env = await readFile(ref.envFile, 'utf8');
    const prev = env.match(/^NEWAPI_VERSION=(.*)$/m)?.[1];
    if (!prev) throw new Error('NEWAPI_VERSION not found in .env');
    await writeFile(ref.envFile, env.replace(/^NEWAPI_VERSION=.*$/m, `NEWAPI_VERSION=${toVersion}`), 'utf8');
    try {
      await dockerCompose.pull(ref);
      await dockerCompose.up(ref);
      await waitHealthy(inst.baseUrl);
    } catch (e) {
      await writeFile(ref.envFile, env, 'utf8');
      await dockerCompose.up(ref).catch(() => undefined);
      throw new Error(`upgrade to ${toVersion} failed, rolled back to ${prev}: ${e instanceof Error ? e.message : e}`);
    }
    return { ...inst, version: toVersion };
  }

  async stop(inst: InstanceInfo): Promise<void> {
    await dockerCompose.stop(composeRef(this.opts.sitesRoot, inst.siteSlug));
  }
  async start(inst: InstanceInfo): Promise<void> {
    await dockerCompose.start(composeRef(this.opts.sitesRoot, inst.siteSlug));
  }
  async destroy(inst: InstanceInfo, opts: { keepData: boolean }): Promise<void> {
    await dockerCompose.down(composeRef(this.opts.sitesRoot, inst.siteSlug), { removeVolumes: !opts.keepData });
  }
}

function getEnv(envText: string, key: string): string {
  return envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '';
}

function reuseEnv(envText: string, spec: SiteSpec): NewapiComposeInput {
  const dsn = getEnv(envText, 'SQL_DSN');
  return {
    slug: spec.slug,
    version: spec.version,
    hostPort: spec.hostPort,
    sessionSecret: getEnv(envText, 'SESSION_SECRET'),
    ...(dsn ? { sqlDsn: dsn } : {}),
  };
}

/** shared 模式：从 serverDsn(不含库名) + dbName 拼 new-api 的 SQL_DSN（postgres 形态） */
function buildSqlDsn(spec: SiteSpec): string {
  const server = spec.database.serverDsn!.replace(/\/$/, '');
  return `${server}/${spec.database.dbName}`;
}
