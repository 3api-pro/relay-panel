import { connect } from 'node:net';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineAdapter,
  EngineAdminClient,
  EngineKind,
  EngineLifecycle,
  GroupRecord,
  InstanceInfo,
  SiteBranding,
  SiteSpec,
  SiteUserRecord,
} from '@relay-panel/adapter-core';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  auditEvents,
  credentials,
  jobs as jobsTable,
  operators,
  sites,
  type AuditEventRow,
  type JobRow,
  type SiteRow,
} from '../db/schema.js';
import { ApiError, canAccessSite, requireWrite, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { redact, writeAudit } from '../audit.js';
import { redactText, type JobEngine, type JobKind, type OnStep } from '../jobs/engine.js';
import { makeCredentialStoreV2 } from '../credstore.js';
import { encryptSecret } from '../secrets.js';
import { activeSites, quotaFor } from '../billing/service.js';
import { assertPublicUrl } from '../net/guard.js';

/**
 * 站点服务（规格 §6，G1 完整版）：DB CRUD、端口分配、快照聚合（吸收原 dashboard.ts）、
 * usage 序列缓存、生命周期 job handler、adapter 装配。
 * 铁律：任何出口（视图/审计/日志/错误信息）不得携带 credentialRef/dataDir/composeProject
 * 与凭据明文；渠道 apiKey 一律 '<redacted>'。
 */

export interface SitesServiceDeps {
  config: Config;
  db: Db;
  adapters: Record<EngineKind, EngineAdapter>;
  lifecycles: Record<EngineKind, EngineLifecycle>;
  jobs: JobEngine;
}

// ---------------------------------------------------------------------------
// 模块级缓存与跨模块契约
// ---------------------------------------------------------------------------

/**
 * 最近一次快照结论（与 G4 的 /metrics 契约：rp_site_up / rp_usage24h_cost 直接读它，
 * 不新发请求）。名字与签名冻结，不得改。destroyed 站会从这里移除。
 */
export const latestSnapshotCache = new Map<string, { ok: boolean; cost24h?: number }>();

/** 实时探测 15s 缓存（规格 §6）；key=slug */
const probeCache = new Map<string, { at: number; probe: SiteProbe }>();
const PROBE_TTL_MS = 15_000;

/** usage 按天序列 10min 缓存；key=`<slug>:<days>` */
const usageCache = new Map<string, { at: number; body: UsageSeries }>();
const USAGE_TTL_MS = 600_000;

/** 测试辅助：清空全部站点级缓存（生产不调用） */
export function clearSiteCaches(): void {
  probeCache.clear();
  usageCache.clear();
  latestSnapshotCache.clear();
}

/**
 * 建站临界区互斥（问题 C/D 修复）：单进程模型下，配额检查 → 端口分配 → 插行三步必须原子，
 * 否则两个并发建站可能都通过配额检查、或分到同一 host_port（checkQuota/allocatePort 与 insert
 * 之间的 TOCTOU 窗口）。用 promise 链做异步互斥把整段串行化——互斥即消除窗口。
 * 一次失败不阻断后续（推进链时吞掉结果，只用于排队，不传播异常）。
 */
let createSiteMutex: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = createSiteMutex.then(fn, fn);
  createSiteMutex = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 判定 insert 是否因 host_port 部分唯一索引(sites_host_port_active_uk)撞车——
 * 互斥外的纵深防御路径（如多进程并发）。node-postgres 带 constraint 字段，
 * pglite 把约束名写进 message，两者都能命中索引名。
 */
function isHostPortUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const constraint = (err as { constraint?: unknown }).constraint;
  const cause = (err as { cause?: unknown }).cause;
  const text = [
    err.message,
    typeof constraint === 'string' ? constraint : '',
    cause instanceof Error ? cause.message : '',
  ].join(' ');
  return /sites_host_port_active_uk|host_port/i.test(text) && /duplicate|unique/i.test(text);
}

/**
 * 生命周期步骤汇聚点。lifecycle 构造期只拿到本函数（index.ts 把它接进
 * makeLifecycles 的 onStep），运行期由当前 job handler 按 slug 注册真正的落库回调
 * ——同 slug 串行由 JobEngine 保证，故 Map 无并发冲突。
 */
const stepSinks = new Map<
  string,
  (step: string, status: 'start' | 'ok' | 'fail', detail?: string) => Promise<void>
>();

export async function lifecycleStepSink(
  slug: string,
  step: string,
  status: 'start' | 'ok' | 'fail',
  detail?: string,
): Promise<void> {
  const sink = stepSinks.get(slug);
  if (sink) await sink(step, status, detail);
}

/**
 * enc: 凭据入库工厂（index.ts 与测试共用）：凭据字段名原样 JSON.stringify 后
 * AES-256-GCM 加密，credentials 表 upsert，ref='enc:<slug>'。明文只在本函数栈内。
 */
export function makeStoreCredential(
  db: Db,
  config: Config,
): (slug: string, secrets: Record<string, string>) => Promise<string> {
  return async (slug, secrets) => {
    const key = config.secretKey;
    if (key === undefined) throw new Error('RP_SECRET_KEY 未配置，无法加密站点凭据');
    const ref = `enc:${slug}`;
    const ciphertext = encryptSecret(JSON.stringify(secrets), key);
    await db.orm
      .insert(credentials)
      .values({ ref, kind: 'admin', ciphertext })
      .onConflictDoUpdate({
        target: credentials.ref,
        set: { ciphertext, rotatedAt: toPgTimestamp(new Date()) },
      });
    return ref;
  };
}

// ---------------------------------------------------------------------------
// 视图类型
// ---------------------------------------------------------------------------

/** 实时探测字段（原 dashboard.ts 的 SiteCard 实时部分）；单站失败降级为 error，不影响他站 */
export interface SiteProbe {
  ok: boolean;
  latencyMs?: number;
  groups?: number;
  accounts?: { total: number; active: number };
  usage24h?: { requests: number; tokens: number; cost: number };
  branding?: string;
  error?: string;
}

/** SiteView = DB 行 + 活跃 job + 实时探测。绝不含 credentialRef/dataDir/composeProject/baseUrl */
export interface SiteView extends SiteProbe {
  id: number;
  slug: string;
  label: string;
  engine: string;
  version: string;
  status: string;
  managed: string;
  readonly: boolean;
  hostPort: number;
  domains: string[];
  notes: string | null;
  operatorId: number;
  operatorEmail: string;
  createdAt: string;
  updatedAt: string;
  activeJob: { id: number; kind: string; status: string } | null;
}

/**
 * 站点元信息（DB 字段，不含实时探测）：批量干跑预览的只读依赖。
 * 只暴露预览需要的字段，绝不含 credentialRef/dataDir/composeProject/baseUrl。
 */
export interface SiteMeta {
  slug: string;
  label: string;
  engine: string;
  version: string;
  status: string;
  managed: string;
  readonly: boolean;
}

export interface UsageBucket {
  date: string;
  requests: number;
  tokens: number;
  cost: number;
}

export interface UsageSeries {
  buckets: UsageBucket[];
  costUnit: string;
}

export interface CreateSiteInput {
  slug: string;
  label: string;
  engine: EngineKind;
  version: string;
  hostPort?: number;
  adminEmail: string;
  branding?: SiteBranding;
}

/** 自助接管存量站（SaaS 面板版 adopt；凭据二选一：admin key 或 admin 邮箱+密码） */
export interface AdoptSiteInput {
  slug: string;
  label?: string;
  baseUrl: string;
  engine: EngineKind;
  adminApiKey?: string;
  adminEmail?: string;
  adminPassword?: string;
  /** 缺省 false；true 时面板对该站只读（引擎写操作全拒），生产站 dogfood 保险丝 */
  readonly?: boolean;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowPg(): string {
  return toPgTimestamp(new Date());
}

function instOf(site: SiteRow): InstanceInfo {
  return {
    siteSlug: site.slug,
    engine: site.engine as EngineKind,
    version: site.version,
    baseUrl: site.baseUrl,
    dataDir: site.dataDir,
    composeProject: site.composeProject,
    credentialRef: site.credentialRef,
  };
}

/**
 * 给 promise 套统一超时：超时即抛错。底层 adapter fetch 自身仍有 AbortSignal 兜底，
 * socket 不会因本 race 泄漏。用于收紧 operator 的 adopt 探测路径防 slowloris 挂起。
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe deadline exceeded')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 300ms TCP 探测：连上=占用；拒绝/超时=空闲 */
function tcpPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    let settled = false;
    const done = (free: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(300);
    sock.once('connect', () => done(false));
    sock.once('timeout', () => done(true));
    sock.once('error', () => done(true));
  });
}

// ---------------------------------------------------------------------------
// SitesService
// ---------------------------------------------------------------------------

export class SitesService {
  private readonly deps: SitesServiceDeps;
  private readonly credstore: CredentialStore;

  constructor(deps: SitesServiceDeps) {
    this.deps = deps;
    this.credstore = makeCredentialStoreV2(deps.db, deps.config);
    this.registerJobHandlers();
  }

  // ---- 读路径 ----

  /** 全量按 id 序；operator 只见自己名下的站（root/viewer 全量） */
  async listSites(ctx: SessionCtx): Promise<SiteView[]> {
    const rows = await this.deps.db.orm
      .select({ site: sites, operatorEmail: operators.email })
      .from(sites)
      .innerJoin(operators, eq(sites.operatorId, operators.id))
      .orderBy(asc(sites.id));
    const visible = rows.filter((r) => canAccessSite(ctx, r.site));
    const jobMap = await this.activeJobsBySlug(visible.map((r) => r.site.slug));
    return Promise.all(
      visible.map(async (r) =>
        this.toView(r.site, r.operatorEmail, jobMap.get(r.site.slug) ?? null, await this.probe(r.site)),
      ),
    );
  }

  /** 不存在与无权访问统一 404（不向 operator 泄露他人站的存在性） */
  async getSite(ctx: SessionCtx, slug: string): Promise<SiteView> {
    const row = await this.requireSiteJoined(ctx, slug);
    const jobMap = await this.activeJobsBySlug([slug]);
    return this.toView(row.site, row.operatorEmail, jobMap.get(slug) ?? null, await this.probe(row.site));
  }

  /**
   * 站点元信息（DB only，不探测引擎）：批量干跑预览取 readonly/status/version/managed。
   * 不存在与无权访问统一 404（语义同 getSite），故 operator 只见自己名下的站。
   */
  async getSiteMeta(ctx: SessionCtx, slug: string): Promise<SiteMeta> {
    const site = await this.requireSite(ctx, slug);
    return {
      slug: site.slug,
      label: site.label,
      engine: site.engine,
      version: site.version,
      status: site.status,
      managed: site.managed,
      readonly: site.readonly,
    };
  }

  async listChannels(ctx: SessionCtx, slug: string): Promise<ChannelRecord[]> {
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    const recs = await this.adapterRead(() => client.channels.list());
    return recs.map((c) => sanitizeChannel(c));
  }

  async listGroups(ctx: SessionCtx, slug: string): Promise<GroupRecord[]> {
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    return this.adapterRead(() => client.groups.list());
  }

  async listUsers(ctx: SessionCtx, slug: string, search?: string): Promise<SiteUserRecord[]> {
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    return this.adapterRead(() =>
      client.users.list(search !== undefined ? { search } : undefined),
    );
  }

  async getBranding(ctx: SessionCtx, slug: string): Promise<SiteBranding> {
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    return this.adapterRead(() => client.settings.getBranding());
  }

  /** 按天调 adapter.stats.usage 聚合成日桶，10min 缓存（UTC 日界） */
  async usageSeries(ctx: SessionCtx, slug: string, days: number): Promise<UsageSeries> {
    const site = await this.requireSite(ctx, slug);
    const key = `${site.slug}:${days}`;
    const cached = usageCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < USAGE_TTL_MS) return cached.body;

    const client = await this.client(site);
    const dayMs = 86_400_000;
    const d = new Date();
    const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const raw = await this.adapterRead(() =>
      Promise.all(
        Array.from({ length: days }, async (_, i) => {
          const from = new Date(todayStart - (days - 1 - i) * dayMs);
          const to = new Date(from.getTime() + dayMs);
          const s = await client.stats.usage(from, to);
          return {
            date: from.toISOString().slice(0, 10),
            requests: s.requests,
            tokens: s.promptTokens + s.completionTokens,
            cost: s.cost,
            costUnit: s.costUnit,
          };
        }),
      ),
    );
    const body: UsageSeries = {
      buckets: raw.map(({ costUnit: _unit, ...bucket }) => bucket),
      costUnit: raw[0]?.costUnit ?? 'USD',
    };
    usageCache.set(key, { at: now, body });
    return body;
  }

  /** 该站审计流水（写入时已过 redact，原样返回） */
  async auditTrail(ctx: SessionCtx, slug: string, limit: number): Promise<AuditEventRow[]> {
    const site = await this.requireSite(ctx, slug);
    const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
    return this.deps.db.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.siteId, site.id))
      .orderBy(desc(auditEvents.id))
      .limit(capped);
  }

  // ---- 写路径：站点生命周期 ----

  /** 建站：配额检查 → 端口分配 → 插 pending 行 → enqueue provision */
  async createSite(ctx: SessionCtx, input: CreateSiteInput): Promise<{ slug: string; jobId: number; hostPort: number }> {
    requireWrite(ctx);

    // 配额检查 → 端口分配 → 插行整段串行化（问题 C/D：消除 TOCTOU 双分端口/突破配额）
    const site = await runExclusive(async () => {
      await this.checkQuota(ctx);

      const dup = await this.deps.db.orm
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.slug, input.slug))
        .limit(1);
      if (dup.length > 0) throw new ApiError(409, '站点标识已存在');

      let hostPort: number;
      if (input.hostPort !== undefined) {
        // 显式端口只查 DB 占用（保持行为可预期，不做 TCP 探测）
        const used = await this.deps.db.orm
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.hostPort, input.hostPort), ne(sites.status, 'destroyed')))
          .limit(1);
        if (used.length > 0) throw new ApiError(409, '端口已被其他站点占用');
        hostPort = input.hostPort;
      } else {
        hostPort = await this.allocatePort();
      }

      try {
        const inserted = await this.deps.db.orm
          .insert(sites)
          .values({
            operatorId: ctx.operatorId,
            slug: input.slug,
            label: input.label,
            engine: input.engine,
            version: input.version,
            hostPort,
            baseUrl: `http://127.0.0.1:${hostPort}`,
            status: 'pending',
            managed: 'compose',
          })
          .returning();
        return inserted[0]!;
      } catch (err) {
        // 纵深防御：互斥外若仍撞 host_port 唯一索引，映射为 409（不泄露内部约束细节）
        if (isHostPortUniqueViolation(err)) throw new ApiError(409, '端口已被占用');
        throw err;
      }
    });
    const hostPort = site.hostPort;

    const payload: Record<string, unknown> = {
      version: input.version,
      adminEmail: input.adminEmail,
      ...(input.branding !== undefined ? { branding: input.branding } : {}),
    };
    const { jobId } = await this.enqueueAudited(ctx, site, 'provision', payload, 'site.provision', {
      engine: input.engine,
      version: input.version,
      hostPort,
    });
    return { slug: site.slug, jobId, hostPort };
  }

  /**
   * 接管存量站（面板自助版；CLI adopt 的带凭据校验加强版）：
   * 配额检查 → 凭据加密入库 → 健康探测 + admin 凭据实连验证 → 插 managed='external' 行。
   * 存量站接入即计入配额（activeSites 不区分 managed），统一管理本身是订阅的一部分。
   */
  async adoptSite(ctx: SessionCtx, input: AdoptSiteInput): Promise<{ slug: string; siteId: number }> {
    requireWrite(ctx);

    let parsed: URL;
    try {
      parsed = new URL(input.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new ApiError(400, 'baseUrl 无效：需要 http(s) 地址');
    }
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    const hostPort = parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

    // 🔴 出站地址守卫（防 SSRF 内网端口扫描）：operator 强制校验，root 豁免（内网自有站/dogfood）。
    // 面板直连路径 failClosed=true——合法公网站点必然快速可解析，解析不了即拒。
    // 命中抛统一「不允许的目标地址」，与探测失败同为 400，攻击者无法区分"内网被拦"与"连不上"。
    await assertPublicUrl(input.baseUrl, { skip: ctx.role === 'root', failClosed: true });

    const hasKey = typeof input.adminApiKey === 'string' && input.adminApiKey.length > 0;
    const hasPassword =
      typeof input.adminEmail === 'string' &&
      input.adminEmail.length > 0 &&
      typeof input.adminPassword === 'string' &&
      input.adminPassword.length > 0;
    if (!hasKey && !hasPassword) {
      throw new ApiError(400, '需要提供站点 admin API key，或 admin 邮箱+密码');
    }

    const site = await runExclusive(async () => {
      await this.checkQuota(ctx);
      const dup = await this.deps.db.orm
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.slug, input.slug))
        .limit(1);
      if (dup.length > 0) throw new ApiError(409, '站点标识已存在');

      // 凭据先入库（enc:<slug>），验证走统一 credstore 路径 —— 与运行期同一条解析链
      const secrets: Record<string, string> = hasKey
        ? { adminApiKey: input.adminApiKey! }
        : { adminEmail: input.adminEmail!, adminPassword: input.adminPassword! };
      const credentialRef = await makeStoreCredential(this.deps.db, this.deps.config)(input.slug, secrets);

      const inserted = await this.deps.db.orm
        .insert(sites)
        .values({
          operatorId: ctx.operatorId,
          slug: input.slug,
          label: input.label ?? input.slug,
          engine: input.engine,
          version: 'prod', // 存量站版本未知（探测成功后回填）
          hostPort,
          baseUrl,
          credentialRef,
          managed: 'external',
          readonly: input.readonly === true,
          status: 'active',
        })
        .returning();
      return inserted[0]!;
    });

    // 健康探测 + admin 凭据实连验证；失败回滚（删行+删凭据），不留半接入状态
    const isRoot = ctx.role === 'root';
    try {
      const adapter = this.deps.adapters[input.engine];
      if (!adapter) throw new ApiError(500, `没有引擎 ${input.engine} 的 adapter`);
      const inst = instOf(site);
      // operator 路径统一较短超时防 slowloris 挂起；root 走引擎原 8s/30s 超时便于自查
      const probe = async (): Promise<{ version?: string }> => {
        const health = await adapter.health(inst);
        if (!health.ok) {
          throw new ApiError(409, `站点健康探测未通过: ${redactText(health.detail ?? 'unhealthy')}`);
        }
        const client = await adapter.connect(inst, this.credstore);
        await client.settings.getBranding(); // admin 凭据无效在这里暴露
        return { ...(health.version !== undefined ? { version: health.version } : {}) };
      };
      const health = isRoot
        ? await probe()
        : await withDeadline(probe(), this.deps.config.adoptProbeTimeoutMs);
      if (health.version !== undefined && health.version !== '') {
        await this.deps.db.orm
          .update(sites)
          .set({ version: health.version, updatedAt: nowPg() })
          .where(eq(sites.id, site.id));
      }
    } catch (err) {
      await this.deps.db.orm.delete(sites).where(eq(sites.id, site.id));
      await this.deps.db.orm.delete(credentials).where(eq(credentials.ref, site.credentialRef));
      // 审计仍记详细错误（内部可见，已脱敏）；对外错误按角色区分。
      await writeAudit(this.deps.db, {
        actor: ctx.email,
        action: 'site.adopt',
        payload: { slug: input.slug, engine: input.engine },
        ok: false,
        error: redactText(errMsg(err)),
      });
      // 🔴 operator 路径：一律统一模糊错误，绝不回显连接错误串/响应体/超时差异（消除内网扫描 oracle）；
      // root 保留详细错误便于自查内网自有站。
      if (isRoot) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(409, `站点验证失败: ${redactText(errMsg(err))}`);
      }
      throw new ApiError(400, '站点探测失败，请检查地址与凭据');
    }

    probeCache.delete(site.slug);
    await writeAudit(this.deps.db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'site.adopt',
      payload: {
        slug: site.slug,
        engine: input.engine,
        label: site.label,
        readonly: input.readonly === true,
      },
      ok: true,
    });
    return { slug: site.slug, siteId: site.id };
  }

  /** 站点标记更新（readonly 保险丝 / 展示名）；owner 或 root */
  async setSiteFlags(
    ctx: SessionCtx,
    slug: string,
    patch: { readonly?: boolean; label?: string; notes?: string },
  ): Promise<void> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    const fields: Record<string, unknown> = { updatedAt: nowPg() };
    if (patch.readonly !== undefined) fields.readonly = patch.readonly;
    if (patch.label !== undefined) fields.label = patch.label;
    if (patch.notes !== undefined) fields.notes = patch.notes;
    await this.deps.db.orm.update(sites).set(fields).where(eq(sites.id, site.id));
    await writeAudit(this.deps.db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'site.flags',
      payload: { slug: site.slug, ...patch },
      ok: true,
    });
  }

  async upgradeSite(ctx: SessionCtx, slug: string, toVersion: string): Promise<{ slug: string; jobId: number }> {
    requireWrite(ctx);
    const site = await this.requireComposeSite(ctx, slug);
    return this.enqueueAudited(ctx, site, 'upgrade', { toVersion }, 'site.upgrade', { toVersion });
  }

  async startSite(ctx: SessionCtx, slug: string): Promise<{ slug: string; jobId: number }> {
    requireWrite(ctx);
    const site = await this.requireComposeSite(ctx, slug);
    return this.enqueueAudited(ctx, site, 'start', undefined, 'site.start', {});
  }

  async stopSite(ctx: SessionCtx, slug: string): Promise<{ slug: string; jobId: number }> {
    requireWrite(ctx);
    const site = await this.requireComposeSite(ctx, slug);
    return this.enqueueAudited(ctx, site, 'stop', undefined, 'site.stop', {});
  }

  /**
   * 销毁：confirm 必须与 slug 完全一致。成功后 status='destroyed'（不删行，留审计）；
   * keepData=false 时同时删除 enc: 凭据行，true 时凭据与数据卷都保留。
   */
  async destroySite(
    ctx: SessionCtx,
    slug: string,
    confirm: string,
    keepData: boolean,
  ): Promise<{ slug: string; jobId: number }> {
    requireWrite(ctx);
    const site = await this.requireComposeSite(ctx, slug);
    if (confirm !== slug) throw new ApiError(400, '销毁确认失败：请输入完整站点标识');
    return this.enqueueAudited(ctx, site, 'destroy', { keepData }, 'site.destroy', { keepData });
  }

  // ---- 写路径：引擎 admin 面（渠道/用户/品牌） ----

  async createChannel(ctx: SessionCtx, slug: string, spec: ChannelSpec): Promise<ChannelRecord> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    // 纵深防御：渠道 baseUrl 由 operator 可控且引擎会去 fetch，禁止指向内网；root 自用豁免。
    await assertPublicUrl(spec.baseUrl, { skip: ctx.role === 'root' });
    const client = await this.client(site);
    const rec = await this.adapterWrite(ctx, site, 'channel.create', {
      name: spec.name,
      protocol: spec.protocol,
      models: spec.models,
    }, () => client.channels.create(spec));
    return sanitizeChannel(rec);
  }

  async updateChannel(
    ctx: SessionCtx,
    slug: string,
    channelId: string,
    patch: Partial<ChannelSpec> & { enabled?: boolean },
  ): Promise<ChannelRecord> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    // 改到新 baseUrl 时同样过内网守卫（root 豁免）
    if (patch.baseUrl !== undefined) {
      await assertPublicUrl(patch.baseUrl, { skip: ctx.role === 'root' });
    }
    const client = await this.client(site);
    const rec = await this.adapterWrite(ctx, site, 'channel.update', {
      channelId,
      fields: Object.keys(patch),
    }, () => client.channels.update(channelId, patch));
    return sanitizeChannel(rec);
  }

  async deleteChannel(ctx: SessionCtx, slug: string, channelId: string): Promise<void> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    await this.adapterWrite(ctx, site, 'channel.delete', { channelId }, () =>
      client.channels.remove(channelId),
    );
  }

  async testChannel(
    ctx: SessionCtx,
    slug: string,
    channelId: string,
    model?: string,
  ): Promise<ChannelTestResult> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    const result = await this.adapterRead(() => client.channels.test(channelId, model));
    // 审计以测试结论为准；引擎回传的错误文本过文本脱敏
    const error = result.error !== undefined ? redactText(result.error) : undefined;
    await writeAudit(this.deps.db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'channel.test',
      payload: { slug: site.slug, channelId, ...(model !== undefined ? { model } : {}) },
      ok: result.ok,
      ...(error !== undefined ? { error } : {}),
    });
    return {
      ok: result.ok,
      ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.model !== undefined ? { model: result.model } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async setUserStatus(
    ctx: SessionCtx,
    slug: string,
    userId: string,
    status: 'active' | 'disabled',
  ): Promise<void> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    await this.adapterWrite(ctx, site, 'user.status', { userId, status }, () =>
      client.users.setStatus(userId, status),
    );
  }

  async setBranding(ctx: SessionCtx, slug: string, patch: Partial<SiteBranding>): Promise<void> {
    requireWrite(ctx);
    const site = await this.requireSite(ctx, slug);
    const client = await this.client(site);
    await this.adapterWrite(ctx, site, 'branding.update', { fields: Object.keys(patch) }, () =>
      client.settings.setBranding(patch),
    );
    probeCache.delete(site.slug); // 品牌名进快照，改后立刻可见
  }

  // ---- job handlers（注册进 JobEngine；构造时装配，boot 即生效） ----

  private registerJobHandlers(): void {
    const { jobs } = this.deps;
    jobs.registerHandler('provision', (job, onStep) => this.handleProvision(job, onStep));
    jobs.registerHandler('upgrade', (job, onStep) => this.handleLifecycleJob(job, onStep, 'upgrade'));
    jobs.registerHandler('start', (job, onStep) => this.handleLifecycleJob(job, onStep, 'start'));
    jobs.registerHandler('stop', (job, onStep) => this.handleLifecycleJob(job, onStep, 'stop'));
    jobs.registerHandler('destroy', (job, onStep) => this.handleLifecycleJob(job, onStep, 'destroy'));
  }

  private async handleProvision(job: JobRow, onStep: OnStep): Promise<void> {
    const db = this.deps.db;
    const site = await this.siteBySlug(job.slug);
    const lifecycle = this.lifecycleOf(site);
    const payload = (job.payload ?? {}) as { adminEmail?: unknown; branding?: SiteBranding };
    const adminEmail = typeof payload.adminEmail === 'string' ? payload.adminEmail : '';
    if (!adminEmail) throw new Error('provision payload 缺少 adminEmail');

    await db.orm
      .update(sites)
      .set({ status: 'provisioning', updatedAt: nowPg() })
      .where(eq(sites.id, site.id));

    const spec: SiteSpec = {
      slug: site.slug,
      engine: site.engine as EngineKind,
      version: site.version,
      domains: site.domains,
      hostPort: site.hostPort,
      database: { mode: 'dedicated', dbName: site.slug },
      adminEmail,
      ...(payload.branding !== undefined ? { branding: payload.branding } : {}),
    };

    // lifecycle 的 onStep 经模块级 stepSinks 汇入本 job 的 steps；失败步骤名用于 failed:<step>
    const tracker = { started: '', failed: '' };
    stepSinks.set(site.slug, async (step, status, detail) => {
      if (status === 'start') tracker.started = step;
      if (status === 'fail') tracker.failed = step;
      await onStep(step, status, detail);
    });
    try {
      const inst = await lifecycle.provision(spec);
      await db.orm
        .update(sites)
        .set({
          status: 'active',
          baseUrl: inst.baseUrl,
          dataDir: inst.dataDir,
          composeProject: inst.composeProject,
          credentialRef: inst.credentialRef,
          version: inst.version,
          updatedAt: nowPg(),
        })
        .where(eq(sites.id, site.id));
      probeCache.delete(site.slug);
      await writeAudit(db, {
        siteId: site.id,
        actor: job.createdBy,
        action: 'lifecycle.provision',
        payload: { slug: site.slug, version: inst.version },
        ok: true,
      });
    } catch (err) {
      const failedStep = tracker.failed || tracker.started || 'provision';
      await db.orm
        .update(sites)
        .set({ status: `failed:${failedStep}`, updatedAt: nowPg() })
        .where(eq(sites.id, site.id));
      probeCache.delete(site.slug);
      await writeAudit(db, {
        siteId: site.id,
        actor: job.createdBy,
        action: 'lifecycle.provision',
        payload: { slug: site.slug, step: failedStep },
        ok: false,
        error: redactText(errMsg(err)),
      });
      throw err;
    } finally {
      stepSinks.delete(site.slug);
    }
  }

  /** upgrade/start/stop/destroy 共用骨架：失败不改 status（provision 之外无步骤粒度），job/告警可见 */
  private async handleLifecycleJob(
    job: JobRow,
    onStep: OnStep,
    kind: Exclude<JobKind, 'provision'>,
  ): Promise<void> {
    const db = this.deps.db;
    const site = await this.siteBySlug(job.slug);
    const lifecycle = this.lifecycleOf(site);
    const inst = instOf(site);
    const payload = (job.payload ?? {}) as Record<string, unknown>;

    await onStep(kind, 'start');
    try {
      if (kind === 'upgrade') {
        const toVersion = typeof payload.toVersion === 'string' ? payload.toVersion : '';
        if (!toVersion || toVersion === 'latest') throw new Error('upgrade payload 缺少钉住的 toVersion');
        const next = await lifecycle.upgrade(inst, toVersion);
        await db.orm
          .update(sites)
          .set({ version: next.version, status: 'active', updatedAt: nowPg() })
          .where(eq(sites.id, site.id));
      } else if (kind === 'start') {
        await lifecycle.start(inst);
        await db.orm
          .update(sites)
          .set({ status: 'active', updatedAt: nowPg() })
          .where(eq(sites.id, site.id));
      } else if (kind === 'stop') {
        await lifecycle.stop(inst);
        await db.orm
          .update(sites)
          .set({ status: 'stopped', updatedAt: nowPg() })
          .where(eq(sites.id, site.id));
      } else {
        const keepData = payload.keepData === true;
        await lifecycle.destroy(inst, { keepData });
        const removeCred = !keepData && site.credentialRef.startsWith('enc:');
        await db.orm
          .update(sites)
          .set({
            status: 'destroyed',
            updatedAt: nowPg(),
            ...(removeCred ? { credentialRef: '' } : {}),
          })
          .where(eq(sites.id, site.id));
        if (removeCred) {
          await db.orm.delete(credentials).where(eq(credentials.ref, site.credentialRef));
        }
        latestSnapshotCache.delete(site.slug);
        for (const key of [...usageCache.keys()]) {
          if (key.startsWith(`${site.slug}:`)) usageCache.delete(key);
        }
      }
      probeCache.delete(site.slug);
      await onStep(kind, 'ok');
      await writeAudit(db, {
        siteId: site.id,
        actor: job.createdBy,
        action: `lifecycle.${kind}`,
        payload: { slug: site.slug },
        ok: true,
      });
    } catch (err) {
      await onStep(kind, 'fail', errMsg(err)); // 引擎入库时统一 redactText
      await writeAudit(db, {
        siteId: site.id,
        actor: job.createdBy,
        action: `lifecycle.${kind}`,
        payload: { slug: site.slug },
        ok: false,
        error: redactText(errMsg(err)),
      });
      throw err;
    }
  }

  // ---- 内部：探测 / 端口 / 配额 / 通用工具 ----

  /** 15s 缓存的实时探测；destroyed 跳过并从快照缓存移除 */
  private async probe(site: SiteRow): Promise<SiteProbe> {
    if (site.status === 'destroyed') {
      latestSnapshotCache.delete(site.slug);
      return { ok: false };
    }
    const cached = probeCache.get(site.slug);
    const now = Date.now();
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.probe;
    const probe = await this.probeLive(site);
    probeCache.set(site.slug, { at: now, probe });
    latestSnapshotCache.set(site.slug, {
      ok: probe.ok,
      ...(probe.usage24h !== undefined ? { cost24h: probe.usage24h.cost } : {}),
    });
    return probe;
  }

  /** 沿用原 dashboard.ts 模式：health → connect → 并发聚合；任一环失败降级 error 字段 */
  private async probeLive(site: SiteRow): Promise<SiteProbe> {
    const adapter = this.deps.adapters[site.engine as EngineKind];
    if (!adapter) return { ok: false, error: `没有引擎 ${site.engine} 的 adapter` };
    const inst = instOf(site);
    try {
      const health = await adapter.health(inst);
      const latency = health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {};
      if (!health.ok) {
        return { ok: false, ...latency, error: redactText(health.detail ?? 'unhealthy') };
      }
      const client = await adapter.connect(inst, this.credstore);
      const now = new Date();
      const [groups, channels, usage, branding] = await Promise.all([
        client.groups.list(),
        client.channels.list(),
        client.stats.usage(new Date(now.getTime() - 86_400_000), now),
        client.settings.getBranding(),
      ]);
      return {
        ok: true,
        ...latency,
        groups: groups.length,
        accounts: { total: channels.length, active: channels.filter((c) => c.enabled).length },
        usage24h: {
          requests: usage.requests,
          tokens: usage.promptTokens + usage.completionTokens,
          cost: usage.cost,
        },
        branding: branding.siteName,
      };
    } catch (e) {
      return { ok: false, error: redactText(errMsg(e)) };
    }
  }

  /** RP_PORT_RANGE 内取未被 sites 占用（destroyed 除外）且 TCP 空闲的最小端口 */
  private async allocatePort(): Promise<number> {
    const { portRange } = this.deps.config;
    const rows = await this.deps.db.orm
      .select({ hostPort: sites.hostPort })
      .from(sites)
      .where(ne(sites.status, 'destroyed'));
    const used = new Set(rows.map((r) => r.hostPort));
    for (let p = portRange.min; p <= portRange.max; p++) {
      if (used.has(p)) continue;
      if (await tcpPortFree(p)) return p;
    }
    throw new ApiError(409, '端口池已无可用端口，请扩大 RP_PORT_RANGE');
  }

  /**
   * 配额检查（规格 §9）：委托 billing/service 单一实现，避免与计费模块口径漂移。
   * root/viewer 不限；operator 取有效订阅套餐的 site_quota，无订阅回落 free 档。
   */
  private async checkQuota(ctx: SessionCtx): Promise<void> {
    if (ctx.role !== 'operator') return;
    const db = this.deps.db;
    // 宽限期内配额仍按原计划（graceDays 取自 config）；宽限结束后回落 free 只挡新建站，不动存量站
    const [quota, n] = await Promise.all([
      quotaFor(db, { operatorId: ctx.operatorId, role: ctx.role }, this.deps.config.billingGraceDays),
      activeSites(db, ctx.operatorId),
    ]);
    if (n >= quota) {
      throw new ApiError(403, `站点配额已用完（${n}/${quota}），请升级套餐后再建站`);
    }
  }

  private async requireSiteJoined(
    ctx: SessionCtx,
    slug: string,
  ): Promise<{ site: SiteRow; operatorEmail: string }> {
    const rows = await this.deps.db.orm
      .select({ site: sites, operatorEmail: operators.email })
      .from(sites)
      .innerJoin(operators, eq(sites.operatorId, operators.id))
      .where(eq(sites.slug, slug))
      .limit(1);
    const row = rows[0];
    if (!row || !canAccessSite(ctx, row.site)) throw new ApiError(404, '站点不存在');
    return row;
  }

  private async requireSite(ctx: SessionCtx, slug: string): Promise<SiteRow> {
    return (await this.requireSiteJoined(ctx, slug)).site;
  }

  /** 生命周期写操作的前置：external 站与已销毁站一律拒绝 */
  private async requireComposeSite(ctx: SessionCtx, slug: string): Promise<SiteRow> {
    const site = await this.requireSite(ctx, slug);
    if (site.managed !== 'compose') throw new ApiError(400, '外部接管站点不支持生命周期操作');
    if (site.status === 'destroyed') throw new ApiError(400, '站点已销毁');
    return site;
  }

  private async siteBySlug(slug: string): Promise<SiteRow> {
    const rows = await this.deps.db.orm.select().from(sites).where(eq(sites.slug, slug)).limit(1);
    const site = rows[0];
    if (!site) throw new Error(`站点不存在: ${slug}`);
    return site;
  }

  private lifecycleOf(site: SiteRow): EngineLifecycle {
    const lifecycle = this.deps.lifecycles[site.engine as EngineKind];
    if (!lifecycle) throw new Error(`没有引擎 ${site.engine} 的 lifecycle`);
    return lifecycle;
  }

  /** 引擎 admin 连接；destroyed 拒绝；连接失败统一 502（错误文本脱敏） */
  private async client(site: SiteRow): Promise<EngineAdminClient> {
    if (site.status === 'destroyed') throw new ApiError(400, '站点已销毁');
    const adapter = this.deps.adapters[site.engine as EngineKind];
    if (!adapter) throw new ApiError(500, `没有引擎 ${site.engine} 的 adapter`);
    try {
      return await adapter.connect(instOf(site), this.credstore);
    } catch (e) {
      throw new ApiError(502, `站点连接失败: ${redactText(errMsg(e))}`);
    }
  }

  /** 引擎读操作统一错误包装（502，脱敏） */
  private async adapterRead<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, `引擎操作失败: ${redactText(errMsg(e))}`);
    }
  }

  /** 引擎写操作：readonly 保险丝前置；成功/失败都写审计（payload 过 redact；错误文本脱敏后 502） */
  private async adapterWrite<T>(
    ctx: SessionCtx,
    site: SiteRow,
    action: string,
    payload: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (site.readonly) {
      throw new ApiError(403, '该站点已设为只读，面板拒绝引擎写操作（可在站点设置中关闭只读）');
    }
    try {
      const out = await fn();
      await writeAudit(this.deps.db, {
        siteId: site.id,
        actor: ctx.email,
        action,
        payload: { slug: site.slug, ...payload },
        ok: true,
      });
      return out;
    } catch (e) {
      const msg = redactText(errMsg(e));
      await writeAudit(this.deps.db, {
        siteId: site.id,
        actor: ctx.email,
        action,
        payload: { slug: site.slug, ...payload },
        ok: false,
        error: msg,
      });
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, `引擎操作失败: ${msg}`);
    }
  }

  /** 入队 + 审计（入队冲突 409 也落一条 ok:false 审计再向上抛） */
  private async enqueueAudited(
    ctx: SessionCtx,
    site: SiteRow,
    kind: JobKind,
    payload: Record<string, unknown> | undefined,
    action: string,
    auditPayload: Record<string, unknown>,
  ): Promise<{ slug: string; jobId: number }> {
    try {
      const jobId = await this.deps.jobs.enqueue(kind, site.slug, payload, ctx.email, {
        siteId: site.id,
      });
      await writeAudit(this.deps.db, {
        siteId: site.id,
        actor: ctx.email,
        action,
        payload: { slug: site.slug, ...auditPayload, jobId },
        ok: true,
      });
      return { slug: site.slug, jobId };
    } catch (err) {
      await writeAudit(this.deps.db, {
        siteId: site.id,
        actor: ctx.email,
        action,
        payload: { slug: site.slug, ...auditPayload },
        ok: false,
        error: redactText(errMsg(err)),
      });
      throw err;
    }
  }

  private async activeJobsBySlug(
    slugs: string[],
  ): Promise<Map<string, { id: number; kind: string; status: string }>> {
    const map = new Map<string, { id: number; kind: string; status: string }>();
    if (slugs.length === 0) return map;
    const rows = await this.deps.db.orm
      .select({ id: jobsTable.id, kind: jobsTable.kind, status: jobsTable.status, slug: jobsTable.slug })
      .from(jobsTable)
      .where(and(inArray(jobsTable.slug, slugs), inArray(jobsTable.status, ['queued', 'running'])));
    for (const r of rows) map.set(r.slug, { id: r.id, kind: r.kind, status: r.status });
    return map;
  }

  private toView(
    site: SiteRow,
    operatorEmail: string,
    activeJob: { id: number; kind: string; status: string } | null,
    probe: SiteProbe,
  ): SiteView {
    return {
      id: site.id,
      slug: site.slug,
      label: site.label,
      engine: site.engine,
      version: site.version,
      status: site.status,
      managed: site.managed,
      readonly: site.readonly,
      hostPort: site.hostPort,
      domains: site.domains,
      notes: site.notes,
      operatorId: site.operatorId,
      operatorEmail,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
      activeJob,
      ...probe,
    };
  }
}

/** 渠道出口统一脱敏：apiKey 强制 '<redacted>'，raw 里的敏感 key 一并按 key 打码 */
function sanitizeChannel(rec: ChannelRecord): ChannelRecord {
  return redact({ ...rec, apiKey: '<redacted>' as const }) as ChannelRecord;
}
