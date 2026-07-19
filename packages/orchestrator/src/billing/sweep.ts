import { and, desc, eq } from 'drizzle-orm';
import type { Config, SmtpSettings } from '../config.js';
import type { Db } from '../db/client.js';
import { appSettings, operators, plans, subscriptions, type SubscriptionRow } from '../db/schema.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { redactText } from '../jobs/engine.js';
import { sendMail, type SmtpMessage, type SmtpSend } from '../alerts/smtp.js';

/**
 * 计费扫描循环（订阅生命周期）：参照告警引擎的 interval 模式。
 *  - 把 status=active 且已过 currentPeriodEnd+grace 的订阅收敛为 status='expired'（幂等，审计 actor='system'）；
 *  - 到期提醒邮件四档（T-7 / T-1 / 到期时刻 / 宽限结束），发给 operator 注册邮箱；
 *    幂等依据 subscriptions.reminders_sent（各档已发时间戳），同档绝不重发；续费顺延后该字段被清空重新计。
 *  - 邮件失败只 warn 不中断循环；未配 SMTP（config.smtp=null）静默跳过全部提醒（收敛仍照常执行）。
 * 🔴 存量站点绝不因欠费停止/销毁：本循环只改订阅状态与配额判定，不触碰 sites 表。
 */

const DAY_MS = 86_400_000;

/** 面板公网地址在 app_settings 里的存放 key（root 可经 /api/settings/billing 配置） */
export const PANEL_BASE_URL_SETTINGS_KEY = 'panel_base_url';

/** 提醒建连/命令超时（对齐 EmailNotifier） */
const EMAIL_CONNECT_TIMEOUT_MS = 10_000;
const EMAIL_COMMAND_TIMEOUT_MS = 10_000;

export type ReminderKind = 't7' | 't1' | 'expiry' | 'graceEnd';

export interface BillingSweepDeps {
  config: Config;
  db: Db;
  /** 出信 SMTP 设置（来自 config.smtp，仅内存）；null=未配 SMTP，静默跳过提醒 */
  smtp: SmtpSettings | null;
  /** 注入用发信函数（默认真 sendMail，测试可替身） */
  send?: SmtpSend;
}

export interface BillingSweep {
  stop(): void;
  /** 单轮扫描；测试可手动驱动（与 interval 并发时内部防重入，不 sleep） */
  tick(): Promise<void>;
}

/** pg 时间戳字符串 → UTC ISO；解析失败原样返回 */
function toUtc(pg: string): string {
  try {
    return fromPgTimestamp(pg).toISOString();
  } catch {
    return pg;
  }
}

const REMINDER_TITLE: Record<ReminderKind, string> = {
  t7: '订阅即将到期（7 天）',
  t1: '订阅即将到期（1 天）',
  expiry: '订阅已到期',
  graceEnd: '宽限期已结束',
};

export interface ReminderContext {
  planTitle: string;
  /** 当前周期到期时间（pg 字符串） */
  periodEnd: string;
  /** 宽限期结束时间（pg 字符串）；无宽限时可为 null */
  graceEndsAt: string | null;
  /** 续费入口 URL：配置了面板公网地址时为绝对地址，否则相对路径提示 */
  renewUrl: string;
}

/** 把某一档到期提醒渲染成中文纯文本邮件（主题 + 正文）；不含任何凭据 */
export function renderReminderEmail(kind: ReminderKind, ctx: ReminderContext): { subject: string; text: string } {
  const subject = `[relay-panel] ${REMINDER_TITLE[kind]} - ${ctx.planTitle}`;
  const endUtc = toUtc(ctx.periodEnd);

  // 到期文案按是否有宽限期分支：grace=0（无宽限，到期即回落 free）时绝不能声称「宽限期内配额仍按原计划生效」
  const expiryLead =
    ctx.graceEndsAt !== null
      ? '您的订阅已到期。已进入宽限期，宽限期内配额仍按原计划生效，请尽快续费。'
      : '您的订阅已到期，站点配额已回落至免费档。您名下已有站点不会被停止或销毁，但将无法按原计划新建站点，请尽快续费以恢复权益。';

  const lead: Record<ReminderKind, string> = {
    t7: '您的订阅将于 7 天内到期，为避免服务权益中断，请及时续费。',
    t1: '您的订阅将于 1 天内到期，请尽快续费以免权益中断。',
    expiry: expiryLead,
    graceEnd: '您的订阅宽限期已结束，站点配额已回落至免费档。您名下已有站点不会被停止或销毁，但将无法按原计划新建站点，请续费以恢复权益。',
  };

  const lines = [
    'relay-panel 订阅到期提醒',
    '',
    lead[kind],
    '',
    `套餐: ${ctx.planTitle}`,
    `到期时间(UTC): ${endUtc}`,
  ];
  if (ctx.graceEndsAt !== null && (kind === 'expiry' || kind === 'graceEnd')) {
    lines.push(`宽限期结束(UTC): ${toUtc(ctx.graceEndsAt)}`);
  }
  lines.push('', `续费入口: ${ctx.renewUrl}`, '', '—— 本邮件由 relay-panel 自动发送，请勿直接回复。');
  return { subject, text: lines.join('\n') };
}

/** 判定某订阅本轮到期的提醒档（已发过的不再列入） */
export function dueReminders(
  sub: Pick<SubscriptionRow, 'currentPeriodEnd' | 'remindersSent'>,
  graceDays: number,
  now: number,
): ReminderKind[] {
  const endMs = fromPgTimestamp(sub.currentPeriodEnd).getTime();
  const graceMs = Math.max(0, graceDays) * DAY_MS;
  const graceEndMs = endMs + graceMs;
  const sent = sub.remindersSent ?? {};
  const has = (k: ReminderKind): boolean => typeof sent[k] === 'string';

  const due: ReminderKind[] = [];
  // 到期前预告：命中窗口且未越过到期时刻（越过后由 expiry 档接管）
  if (!has('t7') && now >= endMs - 7 * DAY_MS && now < endMs) due.push('t7');
  if (!has('t1') && now >= endMs - 1 * DAY_MS && now < endMs) due.push('t1');
  // 到期时刻
  if (!has('expiry') && now >= endMs) due.push('expiry');
  // 宽限结束（仅宽限>0 时才是独立一档；grace=0 时与 expiry 重合，不重复发）
  if (graceMs > 0 && !has('graceEnd') && now >= graceEndMs) due.push('graceEnd');
  return due;
}

/**
 * 启动计费扫描。intervalMs>0 起轮询定时器（unref，不阻止进程退出）；
 * intervalMs<=0 不起定时器，tick 只能手动驱动（测试/关闭场景）。
 */
export function startBillingSweep(deps: BillingSweepDeps, intervalMs: number): BillingSweep {
  const { config, db, smtp } = deps;
  const send: SmtpSend = deps.send ?? sendMail;
  const graceDays = Math.max(0, config.billingGraceDays);
  const graceMs = graceDays * DAY_MS;

  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 现读面板公网地址（root 改完即时生效）；未配置返回 null */
  async function panelBaseUrl(): Promise<string | null> {
    const rows = await db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, PANEL_BASE_URL_SETTINGS_KEY))
      .limit(1);
    const url = (rows[0]?.value as { url?: unknown } | undefined)?.url;
    return typeof url === 'string' && url !== '' ? url.replace(/\/+$/, '') : null;
  }

  /** 续费入口 URL：有面板公网地址用绝对地址，否则相对路径提示 */
  function renewUrl(base: string | null): string {
    return base !== null ? `${base}/billing` : '/billing（登录面板 → 计费页续费）';
  }

  /**
   * 发某订阅本轮到期提醒；成功的档合入 reminders_sent（失败只 warn 不记，下轮重试）。
   * 返回本轮成功发送的档集合（供收敛前判定终档是否已送达）。
   */
  async function sendDueReminders(
    sub: SubscriptionRow,
    email: string,
    planTitle: string,
    base: string | null,
    now: number,
  ): Promise<Record<string, string>> {
    if (smtp === null) return {}; // 未配 SMTP：静默跳过（收敛仍照常）
    const due = dueReminders(sub, graceDays, now);
    if (due.length === 0) return {};

    const graceEndsAt = graceMs > 0 ? toPgTimestamp(new Date(fromPgTimestamp(sub.currentPeriodEnd).getTime() + graceMs)) : null;
    const rctx: ReminderContext = {
      planTitle,
      periodEnd: sub.currentPeriodEnd,
      graceEndsAt,
      renewUrl: renewUrl(base),
    };

    const sentNow: Record<string, string> = {};
    const nowIso = new Date(now).toISOString();
    for (const kind of due) {
      const { subject, text } = renderReminderEmail(kind, rctx);
      const message: SmtpMessage = { from: smtp.from, to: email, subject, text };
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
        sentNow[kind] = nowIso;
      } catch (err) {
        // 🔴 错误消息可能内嵌 SMTP 服务端文本，过 redactText 再落；绝不 throw，档不记（下轮重试）
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[billing] 到期提醒邮件发送失败:', redactText(msg));
      }
    }

    if (Object.keys(sentNow).length > 0) {
      // 乐观并发守卫：仅当仍 active 且 currentPeriodEnd 未变才合入。
      // 续费(subscribeOperator)会保持 active 但顺延 currentPeriodEnd 并清空 remindersSent；
      // 若在本轮 await send 期间发生续费，此处 WHERE 会因 currentPeriodEnd 已变而落空，
      // 从而不会用 tick 开始的旧快照覆盖续费刚重置的台账（避免 lost-update）。
      await db.orm
        .update(subscriptions)
        .set({ remindersSent: { ...(sub.remindersSent ?? {}), ...sentNow } })
        .where(
          and(
            eq(subscriptions.id, sub.id),
            eq(subscriptions.status, 'active'),
            eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd),
          ),
        );
    }
    return sentNow;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const base = await panelBaseUrl();
      // 计划标题查表缓存（一轮内复用）
      const planTitleCache = new Map<string, string>();
      const planTitleOf = async (key: string): Promise<string> => {
        const cached = planTitleCache.get(key);
        if (cached !== undefined) return cached;
        const row = (await db.orm.select({ title: plans.title }).from(plans).where(eq(plans.key, key)).limit(1))[0];
        const title = row?.title ?? key;
        planTitleCache.set(key, title);
        return title;
      };

      const rows = await db.orm
        .select({ sub: subscriptions, email: operators.email })
        .from(subscriptions)
        .innerJoin(operators, eq(subscriptions.operatorId, operators.id))
        .where(eq(subscriptions.status, 'active'))
        .orderBy(desc(subscriptions.currentPeriodEnd));

      for (const { sub, email } of rows) {
        try {
          const planTitle = await planTitleOf(sub.planKey);
          // 先发到期提醒（含 graceEnd），再判定收敛——保证 graceEnd 档能在收敛前发出
          const sentNow = await sendDueReminders(sub, email, planTitle, base, now);

          const graceEndMs = fromPgTimestamp(sub.currentPeriodEnd).getTime() + graceMs;
          if (now >= graceEndMs) {
            // 收敛前须确保终档提醒已送达（grace>0=graceEnd，grace=0=expiry）：
            // 收敛后该行离开 active 集合、下轮扫描不再选中，此时若终档提醒本轮发送失败便永久丢失。
            // 故终档未送达（且已配 SMTP）时暂不收敛，保持 active 让下轮按窗口条件自然重试。
            const terminalKind: ReminderKind = graceMs > 0 ? 'graceEnd' : 'expiry';
            const effectiveSent = { ...(sub.remindersSent ?? {}), ...sentNow };
            const terminalDelivered = smtp === null || typeof effectiveSent[terminalKind] === 'string';
            // 收敛为 expired（条件更新抢占，幂等）；同带 currentPeriodEnd 乐观守卫，避免收敛掉本轮刚续费顺延的订阅；审计 actor='system'
            const updated = terminalDelivered
              ? await db.orm
                  .update(subscriptions)
                  .set({ status: 'expired', updatedAt: toPgTimestamp(new Date(now)) })
                  .where(
                    and(
                      eq(subscriptions.id, sub.id),
                      eq(subscriptions.status, 'active'),
                      eq(subscriptions.currentPeriodEnd, sub.currentPeriodEnd),
                    ),
                  )
                  .returning({ id: subscriptions.id })
              : [];
            if (updated.length > 0) {
              await writeAudit(db, {
                actor: 'system',
                action: 'billing.expire',
                payload: { subscriptionId: sub.id, operatorEmail: email, plan: sub.planKey, periodEnd: sub.currentPeriodEnd },
                ok: true,
              });
            }
          }
        } catch (err) {
          // 单条订阅处理失败不拖垮整轮
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[billing] 订阅扫描单条失败:', redactText(msg));
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
        console.warn('[billing] 计费扫描轮询失败:', redactText(msg));
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
