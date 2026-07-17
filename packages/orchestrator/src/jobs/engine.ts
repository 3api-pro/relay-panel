import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs, type JobRow, type JobStep } from '../db/schema.js';

/**
 * 任务引擎（规格 §5）。
 * engine 不 import 任何 lifecycle/adapter —— handler 由外部（SitesService，G1）经
 * registerHandler 注册，保持可单测（测试注册 fake handler）。
 */

export type JobKind = 'provision' | 'upgrade' | 'start' | 'stop' | 'destroy';

/** handler 里上报进度：追加一条 step（detail 入库前过文本脱敏） */
export type OnStep = (step: string, status: string, detail?: string) => Promise<void>;

export type JobHandler = (job: JobRow, onStep: OnStep) => Promise<void>;

/** 任务到达终态（succeeded/failed）后的回调；alerts 引擎用它出 job_failed 告警 */
export type JobFinishCallback = (job: JobRow) => void | Promise<void>;

export interface JobEngineOptions {
  onFinish?: JobFinishCallback;
}

export interface HttpError extends Error {
  statusCode: number;
}

function httpError(statusCode: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

/** 全局同时在跑的 job 上限 */
const GLOBAL_CONCURRENCY = 2;

/**
 * 文本级脱敏：audit.redact() 只按对象 key 打码，而 step detail / error message 是
 * 自由文本，可能内嵌 "password=xxx"、"token: yyy" 之类的键值对或裸 key。
 * 敏感词表与 audit.ts 的 SENSITIVE_KEY_RE 同一语义，宁可多杀不可漏。
 */
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
  /** 终态回调，可随时挂载/替换（G3 alerts 在 index.ts 装配时挂） */
  onFinish: JobFinishCallback | null = null;

  private readonly db: Db;
  private readonly handlers = new Map<JobKind, JobHandler>();
  /** 在跑 job 的执行 promise（id → promise）；size 即当前并发数 */
  private readonly executions = new Map<number, Promise<void>>();
  /** 已派发（含 DB 状态尚未刷成 running 的瞬间），tick 重入时防止重复派发 */
  private readonly dispatchedIds = new Set<number>();
  /** 在跑 slug —— 同 slug 串行的唯一依据 */
  private readonly runningSlugs = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(db: Db, opts: JobEngineOptions = {}) {
    this.db = db;
    if (opts.onFinish !== undefined) this.onFinish = opts.onFinish;
  }

  registerHandler(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** 当前在跑的 job 数（测试/metrics 用） */
  get runningCount(): number {
    return this.executions.size;
  }

  /**
   * 入队。同 slug 已有 queued/running 的 job 时抛 statusCode=409 的错误
   * （Fastify 会把它映射为 409 响应，路由层无需再包装）。
   */
  async enqueue(
    kind: JobKind,
    slug: string,
    payload: Record<string, unknown> | undefined,
    createdBy: string,
    opts: { siteId?: number } = {},
  ): Promise<number> {
    const dup = (
      await this.db.orm
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.slug, slug), inArray(jobs.status, ['queued', 'running'])))
        .limit(1)
    )[0];
    if (dup) {
      throw httpError(409, `站点 ${slug} 已有未完成任务（#${dup.id} ${dup.status}），请等待其结束`);
    }
    const inserted = await this.db.orm
      .insert(jobs)
      .values({
        kind,
        slug,
        createdBy,
        ...(payload !== undefined ? { payload } : {}),
        ...(opts.siteId !== undefined ? { siteId: opts.siteId } : {}),
      })
      .returning({ id: jobs.id });
    return inserted[0]!.id;
  }

  start(intervalMs = 1500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.warn('[jobs] 轮询失败:', redactText(errorMessage(err)));
      });
    }, intervalMs);
    // 空闲时不阻止进程退出
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 单轮调度：把可运行的 queued job 派发到并发上限为止，不等待 job 完成。
   * 测试可直接调用 tick() 同步驱动（配合 idle()），无需 sleep。
   * 返回本轮派发的 job 数。
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0; // 防重入：interval 与手动 tick 并发时只跑一轮
    this.ticking = true;
    try {
      let dispatched = 0;
      while (this.executions.size < GLOBAL_CONCURRENCY) {
        const candidates = await this.db.orm
          .select()
          .from(jobs)
          .where(eq(jobs.status, 'queued'))
          .orderBy(asc(jobs.id))
          .limit(50);
        // find + 标记必须在同一同步段完成，避免 await 间隙重复派发
        const next = candidates.find(
          (j) => !this.dispatchedIds.has(j.id) && !this.runningSlugs.has(j.slug),
        );
        if (!next) break;
        this.dispatch(next);
        dispatched++;
      }
      return dispatched;
    } finally {
      this.ticking = false;
    }
  }

  /** 等待当前所有在跑 job 落地（测试用；不派发新 job） */
  async idle(): Promise<void> {
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions.values()]);
    }
  }

  private dispatch(row: JobRow): void {
    this.dispatchedIds.add(row.id);
    this.runningSlugs.add(row.slug);
    const p = this.runJob(row)
      .catch((err) => {
        // runJob 自身已兜底落库，这里只保证 promise 链不外溢
        console.warn('[jobs] 执行异常未落库:', redactText(errorMessage(err)));
      })
      .finally(() => {
        this.dispatchedIds.delete(row.id);
        this.runningSlugs.delete(row.slug);
        this.executions.delete(row.id);
      });
    this.executions.set(row.id, p);
  }

  private async runJob(row: JobRow): Promise<void> {
    // 认领：仅 queued 可进入 running；已被取消/他处改动则放弃执行
    const claimed = await this.db.orm
      .update(jobs)
      .set({ status: 'running', startedAt: sql`now()` })
      .where(and(eq(jobs.id, row.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    if (claimed.length === 0) return;

    const steps: JobStep[] = Array.isArray(row.steps) ? [...row.steps] : [];
    const onStep: OnStep = async (step, status, detail) => {
      steps.push({
        step,
        status,
        ...(detail !== undefined ? { detail: redactText(detail) } : {}),
        at: new Date().toISOString(),
      });
      await this.db.orm.update(jobs).set({ steps }).where(eq(jobs.id, row.id));
    };

    try {
      const handler = this.handlers.get(row.kind as JobKind);
      if (!handler) throw new Error(`未注册任务处理器: ${row.kind}`);
      await handler(row, onStep);
      await this.db.orm
        .update(jobs)
        .set({ status: 'succeeded', finishedAt: sql`now()` })
        .where(eq(jobs.id, row.id));
    } catch (err) {
      await this.db.orm
        .update(jobs)
        .set({ status: 'failed', error: redactText(errorMessage(err)), finishedAt: sql`now()` })
        .where(eq(jobs.id, row.id));
    }

    if (this.onFinish) {
      try {
        const finalRow = (
          await this.db.orm.select().from(jobs).where(eq(jobs.id, row.id)).limit(1)
        )[0];
        if (finalRow) await this.onFinish(finalRow);
      } catch (err) {
        // 告警钩子失败不反噬任务终态与调度循环
        console.warn('[jobs] onFinish 回调失败:', redactText(errorMessage(err)));
      }
    }
  }
}
