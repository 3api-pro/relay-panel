import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { redact } from '../audit.js';
import type { Db } from '../db/client.js';
import { jobs, sites, type JobRow } from '../db/schema.js';

/**
 * 任务只读路由（规格 §5）。写入口只有 JobEngine.enqueue（由 sites 等写路由触发）。
 * deps 结构化取所需字段 —— buildServer 的完整 deps 对象可直接传入。
 */
export interface JobsRoutesDeps {
  db: Db;
}

/**
 * server.ts 认证钩子写入 req.ctx 的最小结构（与 auth/rbac.ts 的 SessionCtx 结构兼容）。
 * 结构化读取而非 import，避免对并行交付的 auth 模块产生硬依赖。
 */
export interface SessionCtxLike {
  operatorId: number;
  email: string;
  role: string;
}

function ctxOf(req: FastifyRequest): SessionCtxLike | null {
  const ctx = (req as FastifyRequest & { ctx?: SessionCtxLike }).ctx;
  return ctx ?? null;
}

/** root/viewer 全量可见；operator（及未知角色，从严）只看自己站的 job */
function isSiteScoped(ctx: SessionCtxLike): boolean {
  return ctx.role !== 'root' && ctx.role !== 'viewer';
}

/** payload 原样入库供 handler 使用；对外输出时按敏感 key 打码（steps/error 已在引擎写入时脱敏） */
function toApiJob(job: JobRow): JobRow {
  return { ...job, payload: job.payload == null ? job.payload : redact(job.payload) };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRoutesDeps): void {
  app.get<{ Querystring: { slug?: string; limit?: string } }>('/api/jobs', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!ctx) return reply.code(401).send({ error: '未登录' });

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const conds: SQL[] = [];
    if (req.query.slug) conds.push(eq(jobs.slug, req.query.slug));

    let rows: JobRow[];
    if (isSiteScoped(ctx)) {
      // slug 不在 sites 的历史 job 对 operator 不可见（inner join 天然排除）
      const joined = await deps.db.orm
        .select({ job: jobs })
        .from(jobs)
        .innerJoin(sites, eq(sites.slug, jobs.slug))
        .where(and(eq(sites.operatorId, ctx.operatorId), ...conds))
        .orderBy(desc(jobs.id))
        .limit(limit);
      rows = joined.map((r) => r.job);
    } else {
      rows = await deps.db.orm
        .select()
        .from(jobs)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(jobs.id))
        .limit(limit);
    }
    return { jobs: rows.map(toApiJob) };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!ctx) return reply.code(401).send({ error: '未登录' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '无效的任务 id' });

    const job = (await deps.db.orm.select().from(jobs).where(eq(jobs.id, id)).limit(1))[0];
    if (!job) return reply.code(404).send({ error: '任务不存在' });

    if (isSiteScoped(ctx)) {
      const owned = await deps.db.orm
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.slug, job.slug), eq(sites.operatorId, ctx.operatorId)))
        .limit(1);
      if (owned.length === 0) return reply.code(403).send({ error: '无权访问该任务' });
    }
    return { job: toApiJob(job) };
  });
}
