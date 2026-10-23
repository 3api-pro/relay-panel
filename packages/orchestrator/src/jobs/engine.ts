import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs, type JobRow, type JobStep } from '../db/schema.js';
import { executionScope, JobOwnershipLost, liveLease, lockScheduler } from './execution.js';

export type JobKind = 'provision' | 'upgrade' | 'start' | 'stop' | 'destroy';
export type OnStep = (step: string, status: string, detail?: string) => Promise<void>;
export type JobHandler = (job: JobRow, onStep: OnStep) => Promise<void>;
export type JobFinishCallback = (job: JobRow) => void | Promise<void>;
export interface JobEngineOptions { onFinish?: JobFinishCallback }
export interface HttpError extends Error { statusCode: number }
function httpError(statusCode: number, message: string): HttpError { return Object.assign(new Error(message), {statusCode}); }
const GLOBAL_CONCURRENCY = 2;
const LEASE_SECONDS = 60;
const UNCERTAIN_MESSAGE = '执行进程失联或已停止，实际结果未知；请先停止旧进程及其子进程并核对现场，再复核解除占用。';
const SENSITIVE_KV_RE =
  /\b((?:api[-_]?key|access[-_]?key|secret|password|passwd|pwd|token|credentials?|authorization|key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BARE_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export function redactText(text: string): string {
  return text.replace(SENSITIVE_KV_RE, '$1<redacted>').replace(BARE_KEY_RE, '<redacted>');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class JobEngine {
  onFinish: JobFinishCallback | null = null;
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly executions = new Map<number, Promise<void>>();
  private readonly controllers = new Map<number, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private closing = false;
  constructor(private readonly db: Db, opts: JobEngineOptions = {}) { this.onFinish=opts.onFinish??null; }
  registerHandler(kind: JobKind, handler: JobHandler): void { this.handlers.set(kind,handler); }
  get runningCount(): number { return this.executions.size; }

  async enqueue(kind: JobKind, slug: string, payload: Record<string,unknown>|undefined, createdBy: string, opts: {siteId?:number} = {}): Promise<number> {
    return this.db.orm.transaction(async orm => {
      await lockScheduler(orm);
      const [dup]=await orm.select({id:jobs.id,status:jobs.status}).from(jobs).where(and(eq(jobs.slug,slug),inArray(jobs.status,['queued','running','uncertain']))).limit(1);
      if(dup)throw httpError(409,`站点 ${slug} 已有未完成或待复核任务（#${dup.id} ${dup.status}），请先处理该任务`);
      const [created]=await orm.insert(jobs).values({kind,slug,createdBy,...(payload?{payload}:{}),...opts}).returning({id:jobs.id});
      return created!.id;
    });
  }

  /** Expiry never proves failure or stops Docker. Keep both the site fence and capacity slot until reviewed. */
  async reconcileOrphans(): Promise<number> {
    const rows=await this.db.orm.transaction(async orm=>{
      await lockScheduler(orm);
      return orm.update(jobs).set({status:'uncertain',error:UNCERTAIN_MESSAGE,reviewVersion:sql`${jobs.reviewVersion}+1`})
        .where(and(eq(jobs.status,'running'),sql`(${jobs.leaseUntil} IS NULL OR ${jobs.leaseUntil}<=clock_timestamp())`)).returning();
    });
    for(const row of rows)await this.notify(row);
    return rows.length;
  }
  start(intervalMs=1500): void {
    if(this.timer)return;this.closing=false;
    this.timer=setInterval(()=>void this.tick().catch(err=>console.warn('[jobs] 调度失败:',redactText(errorMessage(err)))),intervalMs);
    this.timer.unref();
  }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=null; }
  /** Pause scheduling without aborting an engine operation during panel maintenance. */
  async pause(): Promise<void> {
    this.stop();
    while (this.ticking) await new Promise(r => setTimeout(r, 10));
  }
  async shutdown(): Promise<void> {
    this.stop();this.closing=true;
    for(const controller of this.controllers.values())controller.abort();
    // Wait for an in-progress claim to leave its short transaction before collecting owned executions.
    while(this.ticking)await new Promise(r=>setTimeout(r,10));
    for(const id of this.executions.keys()) {
      const [row]=await this.db.orm.update(jobs).set({status:'uncertain',error:UNCERTAIN_MESSAGE,reviewVersion:sql`${jobs.reviewVersion}+1`}).where(and(eq(jobs.id,id),eq(jobs.status,'running'))).returning();
      if(row)await this.notify(row);
    }
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try { await Promise.race([this.idle(),new Promise<void>(r=>{timeout=setTimeout(r,5000);})]); }
    finally { if(timeout)clearTimeout(timeout); }
  }
  async tick(): Promise<number> {
    if(this.ticking||this.closing)return 0;this.ticking=true;
    try {
      await this.reconcileOrphans();let dispatched=0;
      while(!this.closing&&this.executions.size<GLOBAL_CONCURRENCY) {
        const row=await this.db.orm.transaction(async orm=>{
          await lockScheduler(orm);
          const [count]=await orm.select({n:sql<number>`count(*)::int`}).from(jobs).where(inArray(jobs.status,['running','uncertain']));
          if(count!.n>=GLOBAL_CONCURRENCY)return null;
          const [next]=await orm.select().from(jobs).where(and(eq(jobs.status,'queued'),sql`NOT EXISTS (SELECT 1 FROM jobs active WHERE active.slug=${jobs.slug} AND active.status IN ('running','uncertain'))`)).orderBy(asc(jobs.id)).limit(1).for('update');
          if(!next)return null;
          const [claimed]=await orm.update(jobs).set({status:'running',startedAt:sql`clock_timestamp()`,heartbeatAt:sql`clock_timestamp()`,leaseUntil:sql`clock_timestamp()+${LEASE_SECONDS}*interval '1 second'`,leaseToken:randomUUID()}).where(and(eq(jobs.id,next.id),eq(jobs.status,'queued'))).returning();
          return claimed??null;
        });
        if(!row)break;
        this.dispatch(row);dispatched++;
      }
      return dispatched;
    } finally { this.ticking=false; }
  }
  async idle(): Promise<void> { while(this.executions.size)await Promise.allSettled([...this.executions.values()]); }
  private dispatch(row:JobRow): void {
    const controller=new AbortController();this.controllers.set(row.id,controller);if(this.closing)controller.abort();
    const p=this.runJob(row,controller).catch(err=>console.warn('[jobs] 执行状态待复核:',redactText(errorMessage(err)))).finally(()=>{this.controllers.delete(row.id);this.executions.delete(row.id);});
    this.executions.set(row.id,p);
  }
  private async notify(row:JobRow):Promise<void> {
    try{await this.onFinish?.(row);}catch(err){console.warn('[jobs] 通知失败:',redactText(errorMessage(err)));}
  }
  private async runJob(row:JobRow,controller:AbortController):Promise<void> {
    const token=row.leaseToken!;let renewing=false;
    const renew=setInterval(()=>{
      if(renewing||controller.signal.aborted)return;renewing=true;
      void this.db.orm.update(jobs).set({heartbeatAt:sql`clock_timestamp()`,leaseUntil:sql`clock_timestamp()+${LEASE_SECONDS}*interval '1 second'`}).where(liveLease(row.id,token)).returning({id:jobs.id})
        .then(rows=>{if(!rows.length)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});
    },10_000);renew.unref();
    let status='succeeded',error:string|null=null;
    try {
      await executionScope.run({db:this.db,jobId:row.id,token,controller},async()=>{
        const steps:JobStep[]=Array.isArray(row.steps)?[...row.steps]:[];
        const onStep:OnStep=async(step,status,detail)=>{
          if(controller.signal.aborted)throw new JobOwnershipLost();
          steps.push({step,status,...(detail===undefined?{}:{detail:redactText(detail)}),at:new Date().toISOString()});
          const updated=await this.db.orm.update(jobs).set({steps}).where(liveLease(row.id,token)).returning({id:jobs.id});
          if(!updated.length){controller.abort();throw new JobOwnershipLost();}
        };
        if(controller.signal.aborted)throw new JobOwnershipLost();
        const handler=this.handlers.get(row.kind as JobKind);if(!handler)throw new Error(`未注册任务处理器: ${row.kind}`);
        await handler(row,onStep);
      });
    } catch(err) { status=err instanceof JobOwnershipLost||controller.signal.aborted?'uncertain':'failed';error=status==='uncertain'?UNCERTAIN_MESSAGE:redactText(errorMessage(err)); }
    finally { clearInterval(renew); }
    if(controller.signal.aborted){status='uncertain';error=UNCERTAIN_MESSAGE;}
    let final:JobRow|undefined;
    if(status!=='uncertain') {
      [final]=await this.db.orm.update(jobs).set({status,error,finishedAt:sql`clock_timestamp()`}).where(liveLease(row.id,token)).returning();
    }
    if(!final) {
      [final]=await this.db.orm.update(jobs).set({status:'uncertain',error:UNCERTAIN_MESSAGE,reviewVersion:sql`${jobs.reviewVersion}+1`}).where(and(eq(jobs.id,row.id),eq(jobs.status,'running'),eq(jobs.leaseToken,token))).returning();
    }
    if(final)await this.notify(final);
  }
}
