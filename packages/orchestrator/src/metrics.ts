import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { alerts, jobs, sites } from './db/schema.js';
import * as sitesService from './sites/service.js';

/**
 * GET /metrics（规格 §9）——Prometheus 文本（version 0.0.4）。
 * 访问控制：合法 session（认证钩子挂的 req.ctx）或 Bearer RP_METRICS_TOKEN。
 * 输出 sites/jobs/alerts 三组 DB 计数 + rp_site_up / rp_usage24h_cost
 * 两组快照指标（读 sites/service.ts 的 latestSnapshotCache，不新发探测请求）。
 */

/** G1 契约：sites/service.ts 导出 latestSnapshotCache（slug → 最近一次快照摘要） */
interface SnapshotLite {
  ok: boolean;
  cost24h?: number;
}

/**
 * 经 namespace 活绑定读取，导出缺失时（G1 未装配的裁剪构建）退化为空——
 * 指标组仍输出 HELP/TYPE 头，只是无样本行。
 */
function snapshotCache(): ReadonlyMap<string, SnapshotLite> | undefined {
  const mod = sitesService as unknown as { latestSnapshotCache?: Map<string, SnapshotLite> };
  return mod.latestSnapshotCache;
}

export interface MetricsRoutesDeps {
  config: Config;
  db: Db;
}

/** label 值转义（Prometheus 文本格式要求：反斜杠、双引号、换行） */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 定长（sha256 后）timing-safe 比较，长度差异不泄露 */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function lines(name: string, help: string, rows: { labels: Record<string, string>; value: number }[]): string {
  const out = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const r of rows) {
    const labelStr = Object.entries(r.labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(',');
    out.push(`${name}{${labelStr}} ${r.value}`);
  }
  return out.join('\n');
}

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRoutesDeps): void {
  const { config, db } = deps;

  app.get('/metrics', async (req, reply) => {
    const bearerOk = config.metricsToken !== undefined && tokenMatches(req.headers.authorization, config.metricsToken);
    if (!req.ctx && !bearerOk) {
      return reply.code(401).send({ error: '未授权' });
    }

    const [siteRows, jobRows, alertRows] = await Promise.all([
      db.orm
        .select({ status: sites.status, n: sql<number>`count(*)::int` })
        .from(sites)
        .groupBy(sites.status),
      db.orm
        .select({ status: jobs.status, n: sql<number>`count(*)::int` })
        .from(jobs)
        .groupBy(jobs.status),
      db.orm
        .select({ severity: alerts.severity, n: sql<number>`count(*)::int` })
        .from(alerts)
        .where(eq(alerts.status, 'open'))
        .groupBy(alerts.severity),
    ]);

    // 快照缓存（G1 维护）按 slug 排序保证输出稳定；不在此发起任何实时探测
    const snapshots = [...(snapshotCache()?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
    const upRows = snapshots.map(([slug, snap]) => ({ labels: { slug }, value: snap.ok ? 1 : 0 }));
    const costRows = snapshots
      .filter(([, snap]) => typeof snap.cost24h === 'number' && Number.isFinite(snap.cost24h))
      .map(([slug, snap]) => ({ labels: { slug }, value: snap.cost24h as number }));

    const body = [
      lines(
        'rp_sites_total',
        'Sites by status',
        siteRows.map((r) => ({ labels: { status: r.status }, value: r.n })),
      ),
      lines(
        'rp_jobs_total',
        'Jobs by status',
        jobRows.map((r) => ({ labels: { status: r.status }, value: r.n })),
      ),
      lines(
        'rp_alerts_open',
        'Open alerts by severity',
        alertRows.map((r) => ({ labels: { severity: r.severity }, value: r.n })),
      ),
      lines('rp_site_up', 'Site reachability from latest snapshot (1=up)', upRows),
      lines('rp_usage24h_cost', 'Site 24h usage cost from latest snapshot', costRows),
    ].join('\n');

    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(`${body}\n`);
  });
}
