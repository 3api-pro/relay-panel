import { and, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { channelGrants, channelTemplates, sites, usageLedger } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import type { MeteringGateway, MeteringUsageRow } from './gateway.js';

/**
 * 用量账本（规格 §7）：网关拉取(source=gateway)与手工补账(source=manual)统一落
 * usage_ledger，(grant_id, period_start, source) 唯一——同期重拉/重导只更新不翻倍。
 * 结算口径：margin = billed_cost - upstream_cost（应收 - 上游成本 = 毛利）。
 */

export type LedgerSource = 'gateway' | 'manual';

/** 账本行输入（网关行与手工补账行同构；period 接受 ISO 或 pg 'YYYY-MM-DD HH:MM:SS' 格式，UTC 口径） */
export type LedgerRowInput = MeteringUsageRow;

function parsePeriod(s: string): Date {
  const d = s.includes('T') || s.endsWith('Z') ? new Date(s) : fromPgTimestamp(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `账期时间格式无效: ${s}`);
  return d;
}

/** 按唯一约束 (grant_id, period_start, source) upsert；返回处理行数 */
export async function upsertRows(
  db: Db,
  grantId: number,
  rows: LedgerRowInput[],
  source: LedgerSource,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const start = parsePeriod(row.periodStart);
    const end = parsePeriod(row.periodEnd);
    if (end.getTime() <= start.getTime()) {
      throw new ApiError(400, '账期时间范围无效: period_end 必须晚于 period_start');
    }
    const periodEnd = toPgTimestamp(end);
    await db.orm
      .insert(usageLedger)
      .values({
        grantId,
        periodStart: toPgTimestamp(start),
        periodEnd,
        requests: row.requests,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        upstreamCost: row.upstreamCost,
        billedCost: row.billedCost,
        source,
      })
      .onConflictDoUpdate({
        target: [usageLedger.grantId, usageLedger.periodStart, usageLedger.source],
        set: {
          periodEnd,
          requests: row.requests,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          upstreamCost: row.upstreamCost,
          billedCost: row.billedCost,
        },
      });
    count += 1;
  }
  return count;
}

export interface PullResult {
  /** 成功拉取的 grant 数 */
  grants: number;
  /** upsert 的账本行数 */
  rows: number;
  /** 拉取失败的 grant 数（单个失败不阻塞其余） */
  errors: number;
}

/**
 * 增量拉取一轮：对全部 active 且带 meter_key_ref 的授权，
 * from = 该 grant 最新 gateway 行的 period_end（首拉用 epoch 全量拉），to = now。
 * 只看 gateway 源的水位——manual 补账不推进网关拉取窗口（手工行是修正，不代表网关已出账）。
 * 🔴 首拉不用 grant.createdAt：①defaultNow 列存的是 PG 会话时区（生产=Asia/Shanghai）的
 * 墙钟时间，当 UTC 解析会把 from 推到未来、永远拉空（7/19 真机事故）；②首个桶的
 * periodStart 会早于授权创建时刻，按 createdAt 过滤会漏掉授权当桶。网关按 keyRef
 * 只存本授权的行 + upsert 幂等，epoch 全量首拉零风险。
 */
const EPOCH = new Date(0);
export async function pullOnce(db: Db, gateway: MeteringGateway, now: Date = new Date()): Promise<PullResult> {
  const grants = await db.orm
    .select()
    .from(channelGrants)
    .where(and(eq(channelGrants.status, 'active'), isNotNull(channelGrants.meterKeyRef)));

  const result: PullResult = { grants: 0, rows: 0, errors: 0 };
  for (const grant of grants) {
    try {
      const latest = await db.orm
        .select({ periodEnd: usageLedger.periodEnd })
        .from(usageLedger)
        .where(and(eq(usageLedger.grantId, grant.id), eq(usageLedger.source, 'gateway')))
        .orderBy(desc(usageLedger.periodEnd))
        .limit(1);
      const from = latest[0] !== undefined ? fromPgTimestamp(latest[0].periodEnd) : EPOCH;
      const rows = await gateway.pullUsage(grant.meterKeyRef!, from, now);
      result.rows += await upsertRows(db, grant.id, rows, 'gateway');
      result.grants += 1;
    } catch (err) {
      result.errors += 1;
      // 只记 grantId 与错误信息（gateway 客户端已保证错误不含 token）
      console.warn(`[ledger] grant ${grant.id} 拉取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** 启动周期拉取循环（启动即先拉一轮）；返回停止函数。timer unref，不阻塞进程退出 */
export function startPullLoop(db: Db, gateway: MeteringGateway, intervalMs: number): () => void {
  const run = (): void => {
    void pullOnce(db, gateway).catch((err) => {
      console.warn(`[ledger] 账本拉取失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface SettlementFilter {
  siteId?: number;
  /** YYYY-MM（UTC 月，按 period_start 归属） */
  month?: string;
}

export interface SettlementRow {
  grantId: number;
  siteId: number;
  siteSlug: string;
  siteLabel: string;
  /** 站点归属 operator（路由层做可见性过滤后剥除，不进响应） */
  operatorId: number;
  templateKey: string;
  templateTitle: string;
  channelName: string | null;
  source: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  upstreamCost: number;
  billedCost: number;
  margin: number;
}

/** 按 grant 汇总账本（gateway+manual 两源合计）；margin = billed - upstream */
export async function settlement(db: Db, filter: SettlementFilter = {}): Promise<SettlementRow[]> {
  const conds = [];
  if (filter.siteId !== undefined) conds.push(eq(channelGrants.siteId, filter.siteId));
  if (filter.month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(filter.month);
    const monthNum = m ? Number(m[2]) : 0;
    if (!m || monthNum < 1 || monthNum > 12) throw new ApiError(400, 'month 格式应为 YYYY-MM');
    const year = Number(m[1]);
    conds.push(
      gte(usageLedger.periodStart, toPgTimestamp(new Date(Date.UTC(year, monthNum - 1, 1)))),
      lt(usageLedger.periodStart, toPgTimestamp(new Date(Date.UTC(year, monthNum, 1)))),
    );
  }

  const rows = await db.orm
    .select({ ledger: usageLedger, grant: channelGrants, template: channelTemplates, site: sites })
    .from(usageLedger)
    .innerJoin(channelGrants, eq(usageLedger.grantId, channelGrants.id))
    .innerJoin(channelTemplates, eq(channelGrants.templateId, channelTemplates.id))
    .innerJoin(sites, eq(channelGrants.siteId, sites.id))
    .where(conds.length > 0 ? and(...conds) : undefined);

  // 行量小（月度×grant 粒度），JS 聚合避免各驱动对 sum(bigint/numeric) 返回类型不一致的坑。
  // 金额列已是 numeric(mode:'number')，读出即 number；此处仍用 Number() 兜底归一
  // （防御 driver/mode 变更导致回字符串时字符串拼接），确保 margin=billed-upstream 无精度漂移。
  const byGrant = new Map<number, SettlementRow>();
  for (const r of rows) {
    let agg = byGrant.get(r.grant.id);
    if (!agg) {
      agg = {
        grantId: r.grant.id,
        siteId: r.site.id,
        siteSlug: r.site.slug,
        siteLabel: r.site.label,
        operatorId: r.site.operatorId,
        templateKey: r.template.key,
        templateTitle: r.template.title,
        channelName: r.grant.channelName,
        source: r.template.source,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        tokens: 0,
        upstreamCost: 0,
        billedCost: 0,
        margin: 0,
      };
      byGrant.set(r.grant.id, agg);
    }
    agg.requests += r.ledger.requests;
    agg.promptTokens += r.ledger.promptTokens;
    agg.completionTokens += r.ledger.completionTokens;
    agg.tokens += r.ledger.promptTokens + r.ledger.completionTokens;
    agg.upstreamCost += Number(r.ledger.upstreamCost);
    agg.billedCost += Number(r.ledger.billedCost);
  }
  for (const agg of byGrant.values()) {
    agg.margin = agg.billedCost - agg.upstreamCost;
  }
  return [...byGrant.values()].sort((a, b) => a.grantId - b.grantId);
}
