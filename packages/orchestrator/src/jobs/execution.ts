import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, Orm } from '../db/client.js';
import { appSettings, jobs } from '../db/schema.js';

export class JobOwnershipLost extends Error {
  constructor() { super('任务执行权已失效；保留现场并复核，不自动重试'); }
}
export interface ExecutionScope {
  db: Db;
  jobId: number;
  token: string;
  controller: AbortController;
}
export const executionScope = new AsyncLocalStorage<ExecutionScope>();
export const executionSignal = () => executionScope.getStore()?.controller.signal;
export const liveLease = (id: number, token: string) => and(
  eq(jobs.id, id),
  eq(jobs.status, 'running'),
  eq(jobs.leaseToken, token),
  sql`${jobs.leaseUntil} > clock_timestamp()`,
);

/** Short database mutex; never held across Docker, HTTP or filesystem operations. */
export async function lockScheduler(orm: Orm): Promise<void> {
  const [row] = await orm.select({ key: appSettings.key }).from(appSettings)
    .where(eq(appSettings.key, 'job_scheduler_mutex')).for('update');
  if (!row) throw new Error('Job scheduler migration is missing');
}

export async function assertExecutionActive(): Promise<void> {
  const scope = executionScope.getStore();
  if (!scope) return;
  try {
    if (!scope.controller.signal.aborted) {
      const [row] = await scope.db.orm.select({ id: jobs.id }).from(jobs)
        .where(liveLease(scope.jobId, scope.token));
      if (row) return;
    }
  } catch {
    // An unavailable database cannot establish ownership or prove the external operation failed.
  }
  scope.controller.abort();
  throw new JobOwnershipLost();
}

/** Fences late workers from changing site/credential state after ownership loss or manual review. */
export async function guardedJobTransaction<T>(db: Db, fn: (orm: Orm) => Promise<T>): Promise<T> {
  const scope = executionScope.getStore();
  try {
    return await db.orm.transaction(async orm => {
      if (scope) {
        const [row] = await orm.select({ id: jobs.id }).from(jobs)
          .where(liveLease(scope.jobId, scope.token)).for('update');
        if (!row || scope.controller.signal.aborted) throw new JobOwnershipLost();
      }
      return fn(orm);
    });
  } catch (error) {
    if (!scope) throw error;
    // A failed state commit after Docker ran must retain the reservation for inspection.
    scope.controller.abort();
    throw new JobOwnershipLost();
  }
}
