import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineLifecycle, InstanceInfo, SiteSpec } from '@relay-panel/adapter-core';
import { dockerCompose, type ComposeRef } from './docker.js';
import { renderSub2apiCompose, renderSub2apiEnv, type Sub2apiComposeInput } from './sub2apiCompose.js';
import { randomHex, randomPassword } from './secrets.js';

export interface Sub2apiLifecycleOptions {
  /** 站点数据根目录，每站一个子目录 <root>/<slug>/ */
  sitesRoot: string;
  /** 生成的凭据交给上层加密入库；返回 credentialRef */
  storeCredential: (
    slug: string,
    secrets: { adminEmail: string; adminPassword: string; jwtSecret: string; postgresPassword: string },
  ) => Promise<string>;
  /** 每步状态回调（落 DB / 审计） */
  onStep?: (slug: string, step: string, status: 'start' | 'ok' | 'fail', detail?: string) => Promise<void>;
}

function composeRef(sitesRoot: string, slug: string): ComposeRef {
  const dir = join(sitesRoot, slug);
  return { project: `rp-${slug}`, file: join(dir, 'docker-compose.yml'), envFile: join(dir, '.env') };
}

async function waitHealthy(baseUrl: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`health check timeout: ${lastErr}`);
}

export class Sub2apiLifecycle implements EngineLifecycle {
  readonly engine = 'sub2api' as const;

  constructor(private readonly opts: Sub2apiLifecycleOptions) {}

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
    if (spec.engine !== 'sub2api') throw new Error(`wrong engine: ${spec.engine}`);
    const dir = join(this.opts.sitesRoot, spec.slug);
    const ref = composeRef(this.opts.sitesRoot, spec.slug);
    const baseUrl = `http://127.0.0.1:${spec.hostPort}`;

    // 1. 目录 + 密钥（幂等：已有 .env 则复用，不重新生成密钥）
    const secrets = await this.step(spec.slug, 'render', async () => {
      await mkdir(dir, { recursive: true });
      let existing: string | null = null;
      try {
        existing = await readFile(ref.envFile, 'utf8');
      } catch {
        /* first run */
      }
      const s: Sub2apiComposeInput = existing
        ? reuseEnv(existing, spec)
        : {
            slug: spec.slug,
            version: spec.version,
            hostPort: spec.hostPort,
            adminEmail: spec.adminEmail,
            postgresPassword: randomHex(16),
            jwtSecret: randomHex(32),
            totpEncryptionKey: randomHex(32),
            adminPassword: randomPassword(),
          };
      await writeFile(ref.envFile, renderSub2apiEnv(s), 'utf8');
      await writeFile(ref.file, renderSub2apiCompose(s), 'utf8');
      return s;
    });

    // 2. 起容器并等 compose 层健康
    await this.step(spec.slug, 'compose-up', () => dockerCompose.up(ref));

    // 3. 应用层健康
    await this.step(spec.slug, 'health', () => waitHealthy(baseUrl));

    // 4. 凭据入库
    const credentialRef = await this.step(spec.slug, 'store-credential', () =>
      this.opts.storeCredential(spec.slug, {
        adminEmail: spec.adminEmail,
        adminPassword: secrets.adminPassword,
        jwtSecret: secrets.jwtSecret,
        postgresPassword: secrets.postgresPassword,
      }),
    );

    return {
      siteSlug: spec.slug,
      engine: 'sub2api',
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
    const envPath = ref.envFile;
    const env = await readFile(envPath, 'utf8');
    const prev = env.match(/^SUB2API_VERSION=(.*)$/m)?.[1];
    if (!prev) throw new Error('SUB2API_VERSION not found in .env');
    const next = env.replace(/^SUB2API_VERSION=.*$/m, `SUB2API_VERSION=${toVersion}`);
    await writeFile(envPath, next, 'utf8');
    try {
      await dockerCompose.pull(ref);
      await dockerCompose.up(ref);
      await waitHealthy(inst.baseUrl);
    } catch (e) {
      // 回滚旧版本 tag 并恢复运行
      await writeFile(envPath, env, 'utf8');
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
    await dockerCompose.down(composeRef(this.opts.sitesRoot, inst.siteSlug), {
      removeVolumes: !opts.keepData,
    });
  }
}

/** 幂等重入：从既有 .env 恢复密钥，端口/版本以新 spec 为准 */
function reuseEnv(envText: string, spec: SiteSpec): Sub2apiComposeInput {
  const get = (key: string) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '';
  return {
    slug: spec.slug,
    version: spec.version,
    hostPort: spec.hostPort,
    adminEmail: spec.adminEmail,
    postgresPassword: get('POSTGRES_PASSWORD'),
    jwtSecret: get('JWT_SECRET'),
    totpEncryptionKey: get('TOTP_ENCRYPTION_KEY'),
    adminPassword: get('ADMIN_PASSWORD'),
  };
}
