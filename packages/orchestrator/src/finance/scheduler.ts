import { eq } from 'drizzle-orm';
import type { SmtpSettings } from '../config.js';
import { appSettings, sites } from '../db/schema.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { redactText } from '../jobs/engine.js';
import { sendMail, type SmtpMessage, type SmtpSend } from '../alerts/smtp.js';
import { ALERT_EMAIL_SETTINGS_KEY, type Notifier } from '../alerts/notify.js';
import { openAlert, type AlertKind } from '../alerts/engine.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { readCostRatios, resolveSummaryRows, summaryTotals } from './summary.js';
import {
  FINANCE_REPORT_SETTINGS_KEY,
  FINANCE_REPORT_STATE_KEY,
  REPORT_SEND_HOUR,
  dailyReportWindow,
  dueReports,
  evaluateThresholds,
  parseReportConfig,
  parseReportState,
  renderDailyReport,
  renderWeeklyReport,
  weeklyReportWindow,
  type FinanceReportConfig,
  type FinanceReportState,
  type ReportKind,
} from './report.js';

/**
 * 经营日报/周报扫描循环（F2）：仿 billing/sweep.ts 的 interval 模式（ticking 防重入 + timer.unref）。
 *  - 每轮读 app_settings['finance_report']（用户配置）与 ['finance_report_state']（发送标记，独立 key）；
 *    dueReports 判定应发的日报/周报档（幂等：state!==目标周期串才发，自愈补发当期，发过不重发）。
 *  - 每档：合成 root ctx 调 SitesService.financeUsage 取当前区间 + 上一等长区间（环比），配成本率覆盖
 *    得逐站汇总行；渲染中文纯文本经 sendMail 发给收件人（逐个 RCPT，任一失败只 warn 不阻断）。
 *  - 阈值命中（margin_low/cost_spike）→ openAlert 复用告警去重扇出（webhook/email）。
 *  - 成功后幂等写发送标记（与配置 key 拆开，PUT 配置绝不清标记、写标记绝不覆配置）。
 * 🔴 纯增量、非破坏：只发邮件 + openAlert，永不写回引擎/额度/触碰 sites 表。
 *    未配 SMTP（smtp=null）或无可解析收件人 → 静默跳过发信（阈值 openAlert 仍照常，走已配扇出）。
 */

const EMAIL_CONNECT_TIMEOUT_MS = 10_000;
const EMAIL_COMMAND_TIMEOUT_MS = 10_000;

/** 合成的系统 root 上下文（operatorId=0 仅用于 RBAC 全站可见，绝不当 siteId 使用） */
const SYSTEM_ROOT_CTX = { operatorId: 0, email: 'system', role: 'root' as const };

export interface FinanceReportsDeps extends SitesServiceDeps {
  /** 告警扇出（openAlert 用）；与告警引擎同一 notifier */
  notifier: Notifier;
  /** 出信 SMTP（来自 config.smtp，仅内存）；null=未配，静默跳过发信 */
  smtp: SmtpSettings | null;
  /** 注入用发信函数（默认真 sendMail，测试可替身） */
  send?: SmtpSend;
  /** 发送时刻（北京小时）；缺省 REPORT_SEND_HOUR，便于测试注入使当期恒应发 */
  sendHour?: number;
}

export interface FinanceReports {
  stop(): void;
  /** 单轮扫描；测试可手动驱动（与 interval 并发时内部防重入，不 sleep） */
  tick(): Promise<void>;
}

export function startFinanceReports(deps: FinanceReportsDeps, intervalMs: number): FinanceReports {
  const { config, db, smtp, notifier } = deps;
  const send: SmtpSend = deps.send ?? sendMail;
  const sendHour = deps.sendHour ?? REPORT_SEND_HOUR;
  const service = new SitesService(deps);

  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 现读 app_settings 单行原始值（root 改完即时生效） */
  async function readSetting(key: string): Promise<unknown> {
    const rows = await db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return rows[0]?.value;
  }

  /** slug → sites.id 映射（openAlert 需真实 site_id；合成 ctx 的 operatorId 绝不当 siteId） */
  async function loadSlugToId(): Promise<Map<string, number>> {
    const rows = await db.orm.select({ id: sites.id, slug: sites.slug }).from(sites);
    return new Map(rows.map((r) => [r.slug, r.id]));
  }

  /** 收件人：finance_report.recipients 优先（留空=回落告警邮箱 alert_email_to.email） */
  async function resolveRecipients(cfg: FinanceReportConfig): Promise<string[]> {
    if (cfg.recipients.length > 0) return cfg.recipients;
    const raw = await readSetting(ALERT_EMAIL_SETTINGS_KEY);
    const email = (raw as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' && email !== '' ? [email] : [];
  }

  /** 逐个 RCPT 发单封纯文本；任一失败只 warn（脱敏）不阻断。返回是否至少送达一封 */
  async function sendToAll(recipients: string[], subject: string, text: string): Promise<boolean> {
    if (smtp === null || recipients.length === 0) return false;
    let anyOk = false;
    for (const to of recipients) {
      const message: SmtpMessage = { from: smtp.from, to, subject, text };
      try {
        await send(
          {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            connectTimeoutMs: EMAIL_CONNECT_TIMEOUT_MS,
            commandTimeoutMs: EMAIL_COMMAND_TIMEOUT_MS,
            ...(smtp.user !== undefined ? { user: smtp.user } : {}),
            ...(smtp.pass !== undefined ? { pass: smtp.pass } : {}),
            ...(smtp.allowInsecureAuth === true ? { allowInsecureAuth: true } : {}),
          },
          message,
        );
        anyOk = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[finance-report] 报告邮件发送失败:', redactText(msg));
      }
    }
    return anyOk;
  }

  /** 开一条阈值告警（margin_low/cost_spike），复用告警去重扇出 */
  async function openThresholdAlert(
    kind: Extract<AlertKind, 'margin_low' | 'cost_spike'>,
    slug: string,
    label: string,
    title: string,
    detail: string,
    slugToId: Map<string, number>,
  ): Promise<void> {
    const siteId = slugToId.get(slug) ?? null;
    await openAlert(db, notifier, {
      kind,
      siteId,
      severity: 'warning',
      title,
      detail,
      ...(siteId !== null ? { site: { slug, label } } : {}),
    });
  }

  const fmt = (n: number): string => (Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2));

  /** 处理单档（daily/weekly）：取数 → 发信 → 阈值告警 → 幂等写标记 */
  async function runReport(
    kind: ReportKind,
    now: number,
    cfg: FinanceReportConfig,
    recipients: string[],
    ratios: Record<string, number>,
    slugToId: Map<string, number>,
    state: FinanceReportState,
  ): Promise<void> {
    const win = kind === 'daily' ? dailyReportWindow(now, sendHour) : weeklyReportWindow(now, sendHour);
    const targetStr = kind === 'daily' ? (win as { target: string }).target : (win as { targetKey: string }).targetKey;

    const [curUsage, prevUsage] = await Promise.all([
      service.financeUsage(SYSTEM_ROOT_CTX, win.from, win.to),
      service.financeUsage(SYSTEM_ROOT_CTX, win.prevFrom, win.prevTo),
    ]);
    const curRows = resolveSummaryRows(curUsage, ratios);
    const prevRows = resolveSummaryRows(prevUsage, ratios);
    // 口径铁律：合计/环比先剔除 ok===false 降级站（探测失败不误报）
    const curTotals = summaryTotals(curRows.filter((r) => r.ok !== false), null);
    const prevTotals = summaryTotals(prevRows.filter((r) => r.ok !== false), null);

    // ---- 发信（未配 SMTP 或无收件人则静默跳过；跳过视为「已处理」，仍写标记）----
    let delivered = true;
    if (smtp !== null && recipients.length > 0) {
      const { subject, text } =
        kind === 'daily'
          ? renderDailyReport(win.from, win.to, curRows, curTotals)
          : renderWeeklyReport(win.from, win.to, curRows, curTotals, prevTotals);
      delivered = await sendToAll(recipients, subject, text);
    }

    // ---- 阈值告警（无自动 resolve，同 job_failed 语义；每轮命中只刷 lastSeenAt）----
    const hits = evaluateThresholds(curRows, prevRows, {
      marginLowPct: cfg.marginLowPct,
      costSpikeFactor: cfg.costSpikeFactor,
    });
    for (const m of hits.marginLow) {
      await openThresholdAlert(
        'margin_low',
        m.slug,
        m.label,
        `${m.label} 毛利率偏低`,
        `毛利率 ${(m.margin * 100).toFixed(1)}% 低于阈值 ${(cfg.marginLowPct * 100).toFixed(0)}%（营收 ${fmt(m.revenue)} USD / 成本 ${fmt(m.cost)} USD）`,
        slugToId,
      );
    }
    for (const c of hits.costSpike) {
      await openThresholdAlert(
        'cost_spike',
        c.slug,
        c.label,
        `${c.label} 成本环比异常`,
        `成本环比 ${c.factor.toFixed(2)}× 超阈值 ${cfg.costSpikeFactor.toFixed(2)}×（当期 ${fmt(c.curCost)} USD / 上期 ${fmt(c.prevCost)} USD）`,
        slugToId,
      );
    }

    // ---- 幂等写发送标记（仅这一个 key；delivered=false（发信全失败）则不记，下轮重试）----
    if (delivered) {
      const next: FinanceReportState = { ...state, [kind]: targetStr };
      Object.assign(state, next); // 让同一 tick 内后续档共享最新 state
      const now2 = toPgTimestamp(new Date());
      const valueJson = next as unknown as Record<string, unknown>;
      await db.orm
        .insert(appSettings)
        .values({ key: FINANCE_REPORT_STATE_KEY, value: valueJson, updatedAt: now2 })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: valueJson, updatedAt: now2 } });
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const cfg = parseReportConfig(await readSetting(FINANCE_REPORT_SETTINGS_KEY));
      const state = parseReportState(await readSetting(FINANCE_REPORT_STATE_KEY));
      // 效果开关 = env master 开关 且 用户配置开关（任一关即关）
      const due = dueReports(now, state, {
        daily: config.reportDaily && cfg.daily,
        weekly: config.reportWeekly && cfg.weekly,
        sendHour,
      });
      if (due.length === 0) return;

      const [ratios, slugToId, recipients] = await Promise.all([
        readCostRatios(db),
        loadSlugToId(),
        resolveRecipients(cfg),
      ]);

      for (const kind of due) {
        try {
          await runReport(kind, now, cfg, recipients, ratios, slugToId, state);
        } catch (err) {
          // 单档失败不拖垮另一档
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[finance-report] ${kind} 报告处理失败:`, redactText(msg));
        }
      }
    } finally {
      ticking = false;
    }
  }

  if (intervalMs > 0) {
    timer = setInterval(() => {
      void tick().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[finance-report] 报告扫描轮询失败:', redactText(msg));
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
