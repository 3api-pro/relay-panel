import { ne } from 'drizzle-orm';
import { customerSnapshots, sites } from '../db/schema.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { redactText } from '../jobs/engine.js';
import { findOpenAlert, openAlert, resolveAlert } from '../alerts/engine.js';
import type { Notifier } from '../alerts/notify.js';
import {
  addDaysStr,
  beijingTodayStr,
  churnAssess,
  collectLiveCustomers,
  detectDrop,
  loadSnapshotHistory,
  periodCostOf,
  readCrmConfig,
  type CrmDeps,
  type LiveCustomer,
} from './service.js';

/**
 * 客户 CRM 每日快照定时器（F4）。照搬 alerts/engine.ts 与 billing/sweep.ts 的 tick+setInterval(unref)+
 * 防重入+stop 模式。每 tick：
 *  - collectLiveCustomers → 对每个成功站的每个客户 upsert customer_snapshots（ON CONFLICT(site,user,date) DO UPDATE，
 *    captured_date=北京今日，period_cost=totalRecharged-balance-frozenBalance），一天内多次 tick 幂等只更今日行；
 *  - ok=false 降级站跳过不快照（collect 已剔除）；单站/单人失败只 warn 不拖垮整轮。
 *  - 可选流失告警：仅当 readCrmConfig().churnAlertsEnabled===true 时，按站聚合触发流失客户 openAlert(kind:'customer_churn')；
 *    默认 false→零告警。告警从此处经 openAlert 触发，startMonitor 主循环零改动。
 * 🔴 纯只读采集 + 只写我方 customer_snapshots；绝不触碰引擎/客户额度/余额。
 */

export interface CustomerSnapshotDeps extends CrmDeps {
  notifier: Notifier;
}

export interface CustomerSnapshot {
  stop(): void;
  /** 单轮快照（测试可手动驱动；与 interval 并发时内部防重入，不 sleep）。返回本轮写入的客户数 */
  tick(): Promise<number>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 执行一轮快照：采集 → 逐客户 upsert 今日行 → 可选流失告警。导出供路由的手动补一轮（seeding）复用。
 * 返回写入客户数。单客户 upsert 失败只 warn。
 */
export async function runCustomerSnapshotOnce(deps: CustomerSnapshotDeps): Promise<number> {
  const { db } = deps;
  const collected = await collectLiveCustomers(deps);
  const today = beijingTodayStr();
  const now = toPgTimestamp(new Date());

  let written = 0;
  for (const c of collected.customers) {
    try {
      const values = {
        siteSlug: c.siteSlug,
        userId: c.userId,
        ...(c.email !== undefined ? { email: c.email } : {}),
        balance: c.balance ?? 0,
        frozenBalance: c.frozenBalance ?? 0,
        totalRecharged: c.totalRecharged ?? 0,
        periodCost: periodCostOf(c),
        status: c.status,
        capturedDate: today,
        capturedAt: now,
      };
      await db.orm
        .insert(customerSnapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [customerSnapshots.siteSlug, customerSnapshots.userId, customerSnapshots.capturedDate],
          set: {
            email: values.email ?? null,
            balance: values.balance,
            frozenBalance: values.frozenBalance,
            totalRecharged: values.totalRecharged,
            periodCost: values.periodCost,
            status: values.status,
            capturedAt: now,
          },
        });
      written += 1;
    } catch (err) {
      console.warn(`[crm] 快照写入失败 ${c.key}:`, redactText(errText(err)));
    }
  }

  // 可选流失告警（默认关闭）
  const cfg = await readCrmConfig(db);
  if (cfg.churnAlertsEnabled) {
    try {
      await emitChurnAlerts(
        deps,
        collected.customers,
        new Set(collected.degradedSites.map((d) => d.siteSlug)),
        today,
      );
    } catch (err) {
      console.warn('[crm] 流失告警聚合失败:', redactText(errText(err)));
    }
  }

  return written;
}

/** 按站聚合流失客户：有流失→openAlert(customer_churn)，无→resolve 既有 open（去重靠 openAlert 的 (kind,siteId)） */
async function emitChurnAlerts(
  deps: CustomerSnapshotDeps,
  customers: LiveCustomer[],
  degradedSlugs: Set<string>,
  today: string,
): Promise<void> {
  const { db, notifier } = deps;
  const cfg = await readCrmConfig(db);

  // openAlert 需 siteId：拉活站 slug→{id,label}
  const siteRows = await db.orm
    .select({ id: sites.id, slug: sites.slug, label: sites.label })
    .from(sites)
    .where(ne(sites.status, 'destroyed'));

  const slugs = [...new Set(customers.map((c) => c.siteSlug))];
  // 拉够两窗口对比的历史（含今日刚写入行）
  const since = addDaysStr(today, -(cfg.dropWindowDays * 2 + 5));
  const history = await loadSnapshotHistory(db, slugs, since);

  // 按站聚合流失客户名单
  const churnBySite = new Map<string, string[]>();
  for (const c of customers) {
    const drop = detectDrop(history.get(c.key) ?? [], cfg);
    const churn = churnAssess(c, drop, cfg);
    if (!churn.churnRisk) continue;
    const who = c.email || `#${c.userId}`;
    const list = churnBySite.get(c.siteSlug) ?? [];
    list.push(who);
    churnBySite.set(c.siteSlug, list);
  }

  for (const s of siteRows) {
    const list = churnBySite.get(s.slug);
    if (list && list.length > 0) {
      const shown = list.slice(0, 10).join(', ');
      await openAlert(db, notifier, {
        kind: 'customer_churn',
        siteId: s.id,
        severity: 'warning',
        title: `${s.label} 客户流失预警`,
        detail: `${list.length} 位客户存在流失风险: ${shown}${list.length > 10 ? ' 等' : ''}`,
        site: { slug: s.slug, label: s.label },
      });
    } else {
      // 🔴 本轮探测降级/不可达的站不做 resolve：无客户名单不代表"流失恢复"，
      // 否则站点短暂不可达会误关 open 的 customer_churn 告警、恢复后又重开=抖动（对齐 risk/service 对降级站 continue）。
      if (degradedSlugs.has(s.slug)) continue;
      const open = await findOpenAlert(db, 'customer_churn', s.id);
      if (open) await resolveAlert(db, notifier, open, { slug: s.slug, label: s.label });
    }
  }
}

/**
 * 启动客户快照循环。intervalMs>0 起独立 setInterval（unref）+ 重入锁；intervalMs<=0 不起循环
 * （tick 仅手动驱动，如 POST /api/customers/snapshot）。
 */
export function startCustomerSnapshot(deps: CustomerSnapshotDeps, intervalMs: number): CustomerSnapshot {
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<number> {
    if (ticking) return 0; // interval 与手动 tick 并发时只跑一轮
    ticking = true;
    try {
      return await runCustomerSnapshotOnce(deps);
    } catch (err) {
      console.warn('[crm] 快照轮失败:', redactText(errText(err)));
      return 0;
    } finally {
      ticking = false;
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void tick().catch((err) => {
        console.warn('[crm] 快照轮询失败:', redactText(errText(err)));
      });
    }, intervalMs);
    timer.unref();
  }

  return {
    tick,
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
