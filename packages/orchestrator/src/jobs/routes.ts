import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lockScheduler } from './execution.js';
import { redactText } from './engine.js';
import { ApiError, requireRoot, requireWrite, tenantId } from '../auth/rbac.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { redact } from '../audit.js';
import type { Db, Orm } from '../db/client.js';
import { auditEvents, jobs, sites, type JobRow } from '../db/schema.js';

/**
 * 任务读取、排队取消与管理员人工复核。执行入口仍由 JobEngine.enqueue 管理。
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
function toApiJob(job: JobRow) {
  const {leaseToken: _leaseToken, ...safe}=job;
  return { ...safe, payload: job.payload == null ? job.payload : redact(job.payload) };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRoutesDeps): void {
  const idSchema=z.coerce.number().int().positive().max(2147483647);
  function parse<T extends z.ZodTypeAny>(schema:T,value:unknown):z.output<T>{const r=schema.safeParse(value);if(!r.success)throw new ApiError(400,'请核对任务、确认项和复核说明');return r.data;}
  async function review(orm:Orm,id:number){
    const [job]=await orm.select().from(jobs).where(eq(jobs.id,id)).for('update');
    if(!job||job.status!=='uncertain')throw new ApiError(409,'仅结果待复核的任务可解除占用');
    const [site]=await orm.select({id:sites.id,label:sites.label,status:sites.status,version:sites.version,updatedAt:sites.updatedAt}).from(sites).where(eq(sites.slug,job.slug)).for('share');
    const [timing]=await orm.select({eligible:sql<boolean>`clock_timestamp() >= coalesce(${jobs.heartbeatAt},${jobs.startedAt},${jobs.createdAt})+interval '5 minutes'`,eligibleAt:sql<string>`(coalesce(${jobs.heartbeatAt},${jobs.startedAt},${jobs.createdAt})+interval '5 minutes')::text`}).from(jobs).where(eq(jobs.id,id));
    const preview={job:toApiJob(job),site:site??null,eligible:timing!.eligible,eligibleAt:timing!.eligibleAt};
    return {...preview,confirmation:createHash('sha256').update(JSON.stringify(preview)).digest('hex')};
  }
  app.get<{Params:{id:string}}>('/api/jobs/:id/review-preview',async req=>{
    requireRoot(req.ctx!);return deps.db.orm.transaction(orm=>review(orm,parse(idSchema,req.params.id)));
  });
  app.post<{Params:{id:string}}>('/api/jobs/:id/resolve',async req=>{
    requireRoot(req.ctx!);
    const b=parse(z.object({confirmation:z.string().regex(/^[a-f0-9]{64}$/),confirmStopped:z.literal(true),outcome:z.enum(['observed-complete','observed-incomplete']),note:z.string().trim().min(10).max(2000)}).strict(),req.body);
    return deps.db.orm.transaction(async orm=>{
      await lockScheduler(orm);const r=await review(orm,parse(idSchema,req.params.id));
      if(!r.eligible||r.confirmation!==b.confirmation)throw new ApiError(409,'请等待复核时间并重新预览；任务或站点状态可能已变化');
      const note=redactText(b.note),at=new Date().toISOString();
      const [row]=await orm.update(jobs).set({status:'resolved',reviewVersion:r.job.reviewVersion+1,reviewNote:note,reviewOutcome:b.outcome,reviewedBy:req.ctx!.operatorId,reviewedAt:sql`clock_timestamp()`,finishedAt:sql`clock_timestamp()`,steps:[...r.job.steps,{step:'manual-review',status:'resolved',detail:`${b.outcome}: ${note}`,at}]}).where(and(eq(jobs.id,r.job.id),eq(jobs.status,'uncertain'))).returning();
      await orm.insert(auditEvents).values({siteId:r.site?.id??null,actor:req.ctx!.email,action:'job.resolved',payload:{jobId:r.job.id,outcome:b.outcome},ok:true});
      return {job:toApiJob(row!)};
    });
  });
  app.post<{Params:{id:string}}>('/api/jobs/:id/cancel',async req=>{
    const ctx=req.ctx!;requireWrite(ctx);
    parse(z.object({confirm:z.literal(true)}).strict(),req.body);
    return deps.db.orm.transaction(async orm=>{
      await lockScheduler(orm);const [job]=await orm.select().from(jobs).where(eq(jobs.id,parse(idSchema,req.params.id))).for('update');
      if(!job)throw new ApiError(404,'任务不存在');
      const [site]=await orm.select().from(sites).where(eq(sites.slug,job.slug)).for('share');
      if(ctx.role!=='root'&&(!site||site.operatorId!==ctx.operatorId||ctx.teamRole||ctx.tenantOwnerId))throw new ApiError(404,'任务不存在');
      if(job.status!=='queued')throw new ApiError(409,'仅尚未执行的排队任务可取消；运行中任务不能靠取消标记停止');
      const [row]=await orm.update(jobs).set({status:'cancelled',finishedAt:sql`clock_timestamp()`}).where(eq(jobs.id,job.id)).returning();
      await orm.insert(auditEvents).values({siteId:site?.id??null,actor:ctx.email,action:'job.cancelled',payload:{jobId:job.id},ok:true});
      return {job:toApiJob(row!)};
    });
  });

  app.get<{ Querystring: { slug?: string; limit?: string; beforeId?: string; status?: string } }>('/api/jobs', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!ctx) return reply.code(401).send({ error: '未登录' });

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const conds: SQL[] = [];
    if (req.query.slug) conds.push(eq(jobs.slug, req.query.slug));
    if(req.query.beforeId){const id=Number(req.query.beforeId);if(!Number.isSafeInteger(id)||id<=0)throw new ApiError(400,'任务游标无效');conds.push(lt(jobs.id,id));}
    if(req.query.status){if(!['queued','running','uncertain','failed','resolved','succeeded','cancelled'].includes(req.query.status))throw new ApiError(400,'任务状态无效');conds.push(eq(jobs.status,req.query.status));}

    let rows: JobRow[];
    if (isSiteScoped(ctx)) {
      // slug 不在 sites 的历史 job 对 operator 不可见（inner join 天然排除）
      const joined = await deps.db.orm
        .select({ job: jobs })
        .from(jobs)
        .innerJoin(sites, eq(sites.slug, jobs.slug))
        .where(and(eq(sites.operatorId, tenantId(ctx)), ...conds))
        .orderBy(desc(jobs.id))
        .limit(limit+1);
      rows = joined.map((r) => r.job);
    } else {
      rows = await deps.db.orm
        .select()
        .from(jobs)
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(jobs.id))
        .limit(limit+1);
    }
    return { jobs: rows.slice(0,limit).map(toApiJob), hasMore: rows.length>limit };
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
        .where(and(eq(sites.slug, job.slug), eq(sites.operatorId, tenantId(ctx))))
        .limit(1);
      if (owned.length === 0) return reply.code(404).send({ error: '任务不存在' });
    }
    return { job: toApiJob(job) };
  });
}
