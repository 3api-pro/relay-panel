import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { appSettings } from '../db/schema.js';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { sendMail, type SmtpSend } from '../alerts/smtp.js';
import { ALERT_EMAIL_SETTINGS_KEY, EmailNotifier } from '../alerts/notify.js';
import { COST_RATIOS_KEY, readCostRatios, resolveSummaryRows, summaryTotals } from './summary.js';
import {
  FINANCE_REPORT_SETTINGS_KEY,
  REPORT_SEND_HOUR,
  dailyReportWindow,
  parseReportConfig,
  renderDailyReport,
  type FinanceReportConfig,
} from './report.js';

// 口径类型的单一定义已迁入 summary.ts；此处 re-export 保持既有 web/api·其它 import 兼容
export type { CostSource, FinanceSummaryRow } from './summary.js';

/**
 * 经营概览路由：跨站营收/成本/毛利汇总。
 *
 * 口径（诚实标注，全部真实数据、非估算）：
 *  - 营收 revenue = 各站引擎记账的用户消费流水（对客价），真实（经 sub2api usage/stats）。
 *  - 成本 cost 默认 = 引擎记账的「上游账户实际成本」total_account_cost（真实 COGS，costSource='engine'）。
 *  - 毛利 profit = revenue − cost；毛利率 = profit / revenue。
 *
 * 成本率覆盖（可选）：root 可在 app_settings['finance_cost_ratios'] 为某站配置成本率，
 *   一旦配置则 cost = revenue × 成本率（costSource='ratio'），用于引擎未给账户成本、
 *   或运营方想以固定比例口径核算的场景。未配置即用引擎真实账户成本。
 *   引擎也未给账户成本且无成本率时 cost/profit 返回 null（前端显示「—」）。
 */

/** 区间最大跨度（天），护栏：避免一次拉过多按天走势 */
const MAX_RANGE_DAYS = 92;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 北京(Asia/Shanghai)当前日历日 YYYY-MM-DD */
function beijingTodayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 校验（含真实日历日校验），非法抛 400 */
function parseDateStr(s: string, label: string): string {
  if (!DATE_RE.test(s)) throw new ApiError(400, `${label} 格式应为 YYYY-MM-DD`);
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ApiError(400, `${label} 不是合法日期`);
  }
  return s;
}

/** 日期串加 delta 天 */
function addDaysStr(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** 枚举 [from, to] 闭区间内的日期串（升序） */
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i <= MAX_RANGE_DAYS && cur <= to; i++) {
    out.push(cur);
    cur = addDaysStr(cur, 1);
  }
  return out;
}

/** PUT body：设置/清除单站成本率（ratio ∈ [0,1]，null=清除） */
const costRatioBody = z.object({
  slug: z.string().min(1),
  ratio: z.number().min(0).max(1).nullable(),
});

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

export interface FinanceBreakdownRow {
  key: string;
  label: string;
  /** 次级标签（客户/渠道维度显示站点名） */
  sublabel?: string;
  revenue: number;
  cost: number;
  profit: number;
  /** 毛利率；营收为 0 时 null */
  margin: number | null;
  /** 亏本：营收 > 0 且成本 > 营收 */
  loss: boolean;
  requests: number;
  tokens: number;
}

function breakdownRow(
  key: string,
  label: string,
  sublabel: string | undefined,
  revenue: number,
  cost: number,
  requests: number,
  tokens: number,
): FinanceBreakdownRow {
  const profit = revenue - cost;
  return {
    key,
    label,
    ...(sublabel !== undefined ? { sublabel } : {}),
    revenue,
    cost,
    profit,
    margin: revenue > 0 ? profit / revenue : null,
    loss: revenue > 0 && cost > revenue,
    requests,
    tokens,
  };
}

function breakdownTotals(rows: FinanceBreakdownRow[]): {
  revenue: number;
  cost: number;
  profit: number;
  requests: number;
  tokens: number;
} {
  return rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.revenue,
      cost: a.cost + r.cost,
      profit: a.profit + r.profit,
      requests: a.requests + r.requests,
      tokens: a.tokens + r.tokens,
    }),
    { revenue: 0, cost: 0, profit: 0, requests: 0, tokens: 0 },
  );
}

/** 测试报告 preview：返回渲染出的报告纯文本前 N 行供 UI 展示（不含任何凭据/上游供应商名） */
const REPORT_PREVIEW_LINES = 20;

export function registerFinanceRoutes(
  app: FastifyInstance,
  // smtpSend 为可选注入（默认真 sendMail）；仅供测试注入 SMTP 发信替身，生产不传即走 sendMail
  deps: SitesServiceDeps & { smtpSend?: SmtpSend },
): void {
  const service = new SitesService(deps);

  // ---- 汇总（含按天走势）----
  // 区间用 from/to（北京日历日 YYYY-MM-DD，闭区间）。缺省=近 7 天（含今日）。
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/finance/summary', async (req) => {
    const ctx = requireCtx(req);
    const today = beijingTodayStr();
    const to = req.query.to ? parseDateStr(req.query.to, 'to') : today;
    const from = req.query.from ? parseDateStr(req.query.from, 'from') : addDaysStr(to, -6);
    if (from > to) throw new ApiError(400, 'from 不能晚于 to');
    const dates = enumerateDates(from, to);
    if (dates.length > MAX_RANGE_DAYS) {
      throw new ApiError(400, `日期区间不能超过 ${MAX_RANGE_DAYS} 天`);
    }

    const [usage, perSiteDaily, recharge] = await Promise.all([
      service.financeUsage(ctx, from, to),
      service.financeTrend(ctx, from, to),
      service.financeRecharge(ctx, from, to),
    ]);
    const ratios = await readCostRatios(deps.db);

    // 口径抽取（summary.ts 单一实现，routes 与报告 scheduler 共用，行为逐字节不变）
    const rows = resolveSummaryRows(usage, ratios);

    const costUnit = usage.find((u) => u.ok)?.costUnit ?? 'USD';
    // 成本/毛利合计只累加「有成本口径」的站点；是否所有站都有成本一并返回给前端提示
    const costed = rows.filter((r) => r.cost !== null);
    const allCosted = rows.length > 0 && costed.length === rows.length;
    // 充值(现金到账)区间合计；全站取不到时 null（不同口径，与营收并列展示）
    const totals = summaryTotals(rows, recharge.ok ? recharge.periodAmount : null);

    // 走势：跨站按日期汇总每日精确营收 + 每日精确成本（成本率覆盖优先，否则引擎当日账户成本）。
    // 营收/成本/毛利/请求每日均为真实值（非分摊），区间合计与表格/卡片一致。
    const dateAgg = new Map<string, { revenue: number; cost: number; requests: number; tokens: number }>();
    for (const date of dates) dateAgg.set(date, { revenue: 0, cost: 0, requests: 0, tokens: 0 });
    for (const site of perSiteDaily) {
      const ratio = site.slug in ratios ? (ratios[site.slug] as number) : null;
      for (const p of site.daily) {
        const agg = dateAgg.get(p.date);
        if (!agg) continue;
        agg.revenue += p.revenue;
        agg.requests += p.requests;
        agg.tokens += p.tokens;
        const c = ratio !== null ? p.revenue * ratio : p.accountCost;
        if (c !== null) agg.cost += c;
      }
    }
    // 每日走势/明细：逐日 充值·消耗(营收)·成本·毛利·请求·token 全含（充值折进每日，不再单列今日充值）
    const trend = dates.map((date) => {
      const a = dateAgg.get(date) as { revenue: number; cost: number; requests: number; tokens: number };
      const rc = recharge.ok ? recharge.byDate[date] ?? 0 : null;
      return {
        date,
        revenue: a.revenue,
        requests: a.requests,
        tokens: a.tokens,
        cost: a.cost,
        profit: a.revenue - a.cost,
        recharge: rc,
      };
    });

    return { from, to, costUnit, rows, totals, allCosted, trend };
  });

  // ---- 经营下钻（按模型/客户/上游渠道）----
  // model/customer 用 from/to（缺省近7天）；account 用 days(1..90，终点今日) 且仅 root。
  app.get<{ Querystring: { dim?: string; from?: string; to?: string; limit?: string; days?: string } }>(
    '/api/finance/breakdown',
    async (req) => {
      const ctx = requireCtx(req);
      const dim = req.query.dim ?? 'model';
      if (dim !== 'model' && dim !== 'customer' && dim !== 'account') {
        throw new ApiError(400, 'dim 须为 model / customer / account');
      }

      // 上游渠道维度：仅 root（会暴露上游账户结构与成本），只吃 days
      if (dim === 'account') {
        requireRoot(ctx);
        const daysRaw = req.query.days;
        const days = daysRaw === undefined ? 7 : Number(daysRaw);
        if (!Number.isInteger(days) || days < 1 || days > 90) {
          throw new ApiError(400, '参数 days 须为 1-90 的整数');
        }
        const raw = await service.financeAccountBreakdown(ctx, days);
        const rows = raw
          .map((r) => breakdownRow(`${r.siteSlug}:${r.accountId}`, r.accountName, r.siteLabel, r.revenue, r.cost, r.requests, r.tokens))
          .sort((a, b) => b.profit - a.profit);
        return { dim, days, rows, totals: breakdownTotals(rows) };
      }

      // model / customer：from/to 闭区间（缺省近 7 天）
      const today = beijingTodayStr();
      const to = req.query.to ? parseDateStr(req.query.to, 'to') : today;
      const from = req.query.from ? parseDateStr(req.query.from, 'from') : addDaysStr(to, -6);
      if (from > to) throw new ApiError(400, 'from 不能晚于 to');
      if (enumerateDates(from, to).length > MAX_RANGE_DAYS) {
        throw new ApiError(400, `日期区间不能超过 ${MAX_RANGE_DAYS} 天`);
      }

      if (dim === 'model') {
        const raw = await service.financeModelBreakdown(ctx, from, to);
        const rows = raw
          .map((m) => breakdownRow(m.model, m.model, undefined, m.revenue, m.cost, m.requests, m.tokens))
          .sort((a, b) => b.profit - a.profit);
        return { dim, from, to, rows, totals: breakdownTotals(rows) };
      }

      // customer：不跨站合并；集中度分母用全站营收合计（summary 口径）
      const limitRaw = req.query.limit;
      const limit = limitRaw === undefined ? 20 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, '参数 limit 须为 1-200 的整数');
      }
      const [rawCustomers, siteUsage] = await Promise.all([
        service.financeCustomerBreakdown(ctx, from, to, Math.max(limit, 3)),
        service.financeUsage(ctx, from, to),
      ]);
      const rows = rawCustomers
        .map((r) => breakdownRow(`${r.siteSlug}:${r.userId}`, r.email || `#${r.userId}`, r.siteLabel, r.revenue, r.cost, r.requests, r.tokens))
        .sort((a, b) => b.revenue - a.revenue);
      const grandRevenue = siteUsage.reduce((a, u) => a + u.revenue, 0);
      // 🔴 有站点探测降级(revenue 漏计) 或 分母<=0 时不给集中度，避免分子分母异源算出 >100%
      const anyDegraded = siteUsage.some((u) => !u.ok);
      const top3 = rows.slice(0, 3).reduce((a, r) => a + r.revenue, 0);
      const concentration = {
        top3Share: grandRevenue > 0 && !anyDegraded ? Math.min(1, top3 / grandRevenue) : null,
        count: rows.length,
      };
      return { dim, from, to, rows: rows.slice(0, limit), totals: breakdownTotals(rows), concentration };
    },
  );

  // ---- 成本率读写（仅 root）----
  app.get('/api/finance/cost-ratios', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return { ratios: await readCostRatios(deps.db) };
  });

  app.put('/api/finance/cost-ratios', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = costRatioBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');
    const { slug, ratio } = parsed.data;

    const current = await readCostRatios(deps.db);
    if (ratio === null) delete current[slug];
    else current[slug] = ratio;

    const now = toPgTimestamp(new Date());
    await deps.db.orm
      .insert(appSettings)
      .values({ key: COST_RATIOS_KEY, value: current, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: current, updatedAt: now } });

    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'finance.cost_ratio.set',
      payload: { slug, ratio },
      ok: true,
    });

    return { ratios: current };
  });

  // ---- 经营报告配置读写（仅 root；F2）----
  // app_settings['finance_report']：收件人/阈值/日报周报开关。仅这一个 key，
  // 绝不触碰 finance_report_state（发送标记，scheduler 独占，两 key 拆开防盲覆盖互踩）。
  const reportConfigBody = z.object({
    recipients: z.array(z.string().email('收件人须为合法邮箱')).max(50).optional(),
    /** 毛利率阈值 0..1 */
    marginLowPct: z.number().min(0).max(1).optional(),
    /** 成本环比倍数 >=1 */
    costSpikeFactor: z.number().min(1).optional(),
    daily: z.boolean().optional(),
    weekly: z.boolean().optional(),
  });

  async function readReportConfigRaw(): Promise<unknown> {
    const rows = await deps.db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, FINANCE_REPORT_SETTINGS_KEY))
      .limit(1);
    return rows[0]?.value;
  }

  /**
   * 收件人解析（与 scheduler.resolveRecipients 同口径）：
   * finance_report.recipients 优先；留空 = 回落告警邮箱 alert_email_to.email；都没有 = 空数组。
   */
  async function resolveReportRecipients(cfg: FinanceReportConfig): Promise<string[]> {
    if (cfg.recipients.length > 0) return cfg.recipients;
    const rows = await deps.db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, ALERT_EMAIL_SETTINGS_KEY))
      .limit(1);
    const email = (rows[0]?.value as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email !== '' ? [email] : [];
  }

  app.get('/api/settings/finance-report', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    return parseReportConfig(await readReportConfigRaw());
  });

  app.put('/api/settings/finance-report', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);
    const parsed = reportConfigBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '参数无效');

    // 合并现值：只覆盖传入字段（PUT 盲 upsert 仅 finance_report 一个 key）
    const current = parseReportConfig(await readReportConfigRaw());
    const next: FinanceReportConfig = {
      recipients: parsed.data.recipients ?? current.recipients,
      marginLowPct: parsed.data.marginLowPct ?? current.marginLowPct,
      costSpikeFactor: parsed.data.costSpikeFactor ?? current.costSpikeFactor,
      daily: parsed.data.daily ?? current.daily,
      weekly: parsed.data.weekly ?? current.weekly,
    };

    const now = toPgTimestamp(new Date());
    const valueJson = next as unknown as Record<string, unknown>;
    await deps.db.orm
      .insert(appSettings)
      .values({ key: FINANCE_REPORT_SETTINGS_KEY, value: valueJson, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: valueJson, updatedAt: now } });

    // 🔴 审计只记 hasRecipients/数量/阈值/开关，绝不记邮箱原值
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'finance.report_config.set',
      payload: {
        hasRecipients: next.recipients.length > 0,
        recipientCount: next.recipients.length,
        marginLowPct: next.marginLowPct,
        costSpikeFactor: next.costSpikeFactor,
        daily: next.daily,
        weekly: next.weekly,
      },
      ok: true,
    });

    return next;
  });

  // ---- 立即发送测试报告（仅 root；F2）----
  // 用当前 finance_report 配置即时渲染一份【日报】(与 scheduler runReport 同口径)并直投收件人，
  // 供 root 一键验证「报告能生成 + SMTP 能送达」，无须等 sweep。
  // 🔴 只发信、只读数——绝不写 finance_report_state（不占用当日发送标记，允许反复测试），
  //    也绝不触碰引擎/额度/sites。收件人/SMTP 缺任一 → 400 明确提示。
  app.post('/api/finance/report/test', async (req) => {
    const ctx = requireCtx(req);
    requireRoot(ctx);

    const cfg = parseReportConfig(await readReportConfigRaw());
    const recipients = await resolveReportRecipients(cfg);
    const smtp = deps.config.smtp ?? null;

    // 两类前置缺失各自明确提示，便于 root 自查（都不发信、不写任何状态）
    if (recipients.length === 0) {
      throw new ApiError(
        400,
        '未配置收件人：请在经营报告设置里填写收件人，或先在告警页配置告警邮箱作为回落收件人',
      );
    }
    if (smtp === null) {
      throw new ApiError(400, '未配置 SMTP 出信（服务端未设 RP_SMTP_*），无法发送测试报告');
    }

    // 与 scheduler 同口径：覆盖最近一个已完整过完的北京日历日
    const now = Date.now();
    const win = dailyReportWindow(now, REPORT_SEND_HOUR);
    const [usage, ratios] = await Promise.all([
      service.financeUsage(ctx, win.from, win.to),
      readCostRatios(deps.db),
    ]);
    const rows = resolveSummaryRows(usage, ratios);
    // 口径铁律：合计先剔除 ok===false 降级站（探测降级不误报），与 scheduler 一致
    const totals = summaryTotals(rows.filter((r) => r.ok !== false), null);
    const { subject, text } = renderDailyReport(win.from, win.to, rows, totals);

    // 经 EmailNotifier 直投（复用同一 SMTP 出信凭据；smtpSend 可注入测试替身，生产走真 sendMail）
    const notifier = new EmailNotifier(deps.db, smtp, deps.smtpSend ?? sendMail);
    const sentCount = await notifier.sendDirect(recipients, subject, text);

    // 🔴 审计只记数量/是否送达/覆盖日，绝不落收件人邮箱原值
    await writeAudit(deps.db, {
      siteId: null,
      actor: ctx.email,
      action: 'finance.report_test.send',
      payload: {
        recipientCount: recipients.length,
        sent: sentCount > 0,
        sentCount,
        target: win.target,
      },
      ok: sentCount > 0,
    });

    const preview = text.split('\n').slice(0, REPORT_PREVIEW_LINES).join('\n');
    // sentCount 透出：部分收件人投递失败时前端可如实提示，不掩盖 SMTP 送达故障
    return { sent: sentCount > 0, sentCount, recipients: recipients.length, preview };
  });
}
