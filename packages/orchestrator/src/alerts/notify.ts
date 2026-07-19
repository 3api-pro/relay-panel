import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { SmtpSettings } from '../config.js';
import { appSettings } from '../db/schema.js';
import { fromPgTimestamp } from '../auth/sessions.js';
import { redactText } from '../jobs/engine.js';
import { sendMail, type SmtpMessage, type SmtpSend } from './smtp.js';

/**
 * 告警通知（规格 §8）。事件负载只含告警行与站点摘要（slug/label），
 * 绝不携带任何凭据/密钥——alert.detail 在告警引擎入库前已过 redactText。
 * 类型与 server.ts 的占位 Notifier/NotifyEvent、test/fakes.ts 的 FakeNotifier 结构同构。
 */

export interface NotifyEvent {
  type: 'open' | 'resolve';
  alert: unknown;
  site?: unknown;
}

export interface Notifier {
  fire(event: NotifyEvent): Promise<void>;
}

/** webhook 地址在 app_settings 里的存放 key（routes.ts 的设置端点写同一行） */
export const WEBHOOK_SETTINGS_KEY = 'alert_webhook_url';

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Webhook 通知器：POST JSON 到 app_settings['alert_webhook_url'].url。
 * 每次触发现读设置（root 改完地址即时生效）；未配置=静默跳过；
 * 任何失败（含超时/非 2xx）只 log，绝不 throw——通知失败不得反噬监控循环。
 */
export class WebhookNotifier implements Notifier {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async fire(event: NotifyEvent): Promise<void> {
    try {
      const rows = await this.db.orm
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, WEBHOOK_SETTINGS_KEY))
        .limit(1);
      const url = (rows[0]?.value as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string' || url === '') return;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[alerts] webhook 通知返回非 2xx: HTTP ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[alerts] webhook 通知失败:', redactText(msg));
    }
  }
}

/** 告警收件人邮箱在 app_settings 里的存放 key（routes.ts 的设置端点写同一行） */
export const ALERT_EMAIL_SETTINGS_KEY = 'alert_email_to';

/** 邮件建连/命令超时（略高于 webhook 的 5s，容忍 SMTP 多轮往返；仍不足以拖垮监控轮） */
const EMAIL_CONNECT_TIMEOUT_MS = 10_000;
const EMAIL_COMMAND_TIMEOUT_MS = 10_000;

/** 告警行结构化子集（NotifyEvent.alert 为 unknown，此处按需读取，容错缺字段） */
interface AlertLike {
  kind?: unknown;
  severity?: unknown;
  title?: unknown;
  detail?: unknown;
  firstSeenAt?: unknown;
  lastSeenAt?: unknown;
  resolvedAt?: unknown;
}
interface SiteLike {
  slug?: unknown;
  label?: unknown;
}

const KIND_LABEL: Record<string, string> = {
  site_down: '站点不可达',
  job_failed: '任务失败',
  channel_disabled: '渠道被禁用',
  low_balance: '渠道余额不足',
};
const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  warning: '警告',
  info: '提示',
};

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** pg 时间戳字符串 → UTC ISO；解析失败原样返回 */
function toUtc(v: unknown): string | undefined {
  const s = asString(v);
  if (s === undefined) return undefined;
  try {
    return fromPgTimestamp(s).toISOString();
  } catch {
    return s;
  }
}

/** 把告警事件渲染成中文纯文本邮件（主题 + 正文）；详情已在入库前脱敏，此处不含凭据 */
export function renderAlertEmail(event: NotifyEvent): { subject: string; text: string } {
  const alert = (event.alert ?? {}) as AlertLike;
  const site = (event.site ?? undefined) as SiteLike | undefined;
  const kind = asString(alert.kind) ?? 'unknown';
  const kindLabel = KIND_LABEL[kind] ?? kind;
  const severityLabel = SEVERITY_LABEL[asString(alert.severity) ?? ''] ?? asString(alert.severity) ?? '—';
  const label = asString(site?.label) ?? '全局';
  const slug = asString(site?.slug);
  const isResolve = event.type === 'resolve';

  const subject = `[relay-panel ${isResolve ? '恢复' : '告警'}] ${label} ${kindLabel}`;

  const time = isResolve
    ? toUtc(alert.resolvedAt) ?? toUtc(alert.lastSeenAt)
    : toUtc(alert.firstSeenAt) ?? toUtc(alert.lastSeenAt);

  const lines = [
    isResolve ? 'relay-panel 告警已恢复' : 'relay-panel 触发新告警',
    '',
    `事件: ${isResolve ? '告警恢复(resolve)' : '新增告警(open)'}`,
    `级别: ${severityLabel}`,
    `类型: ${kindLabel}`,
    `站点: ${slug !== undefined ? `${label} (${slug})` : label}`,
    `标题: ${asString(alert.title) ?? '—'}`,
    `详情: ${asString(alert.detail) ?? '—'}`,
    `时间(UTC): ${time ?? '—'}`,
    '',
    '—— 本邮件由 relay-panel 监控自动发送，请勿直接回复。',
  ];
  return { subject, text: lines.join('\n') };
}

/**
 * 邮件通知器：把告警 open/resolve 事件发到 app_settings['alert_email_to'] 的收件人。
 *  - SMTP 出信凭据全部来自 env（构造时注入 SmtpSettings|null，只在内存）；
 *  - env 未配 SMTP（smtp=null）或收件人为空 → 静默跳过；
 *  - 每次触发现读收件人设置（root 改完即时生效）；
 *  - 任何失败只 console.warn（过 redactText），绝不 throw——通知失败不得反噬监控循环。
 */
export class EmailNotifier implements Notifier {
  private readonly db: Db;
  private readonly smtp: SmtpSettings | null;
  private readonly send: SmtpSend;

  constructor(db: Db, smtp: SmtpSettings | null, send: SmtpSend = sendMail) {
    this.db = db;
    this.smtp = smtp;
    this.send = send;
  }

  async fire(event: NotifyEvent): Promise<void> {
    try {
      if (this.smtp === null) return; // env 未配 SMTP
      const rows = await this.db.orm
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, ALERT_EMAIL_SETTINGS_KEY))
        .limit(1);
      const to = (rows[0]?.value as { email?: unknown } | undefined)?.email;
      if (typeof to !== 'string' || to === '') return; // 收件人未配置

      const { subject, text } = renderAlertEmail(event);
      const message: SmtpMessage = { from: this.smtp.from, to, subject, text };
      await this.send(
        {
          host: this.smtp.host,
          port: this.smtp.port,
          secure: this.smtp.secure,
          connectTimeoutMs: EMAIL_CONNECT_TIMEOUT_MS,
          commandTimeoutMs: EMAIL_COMMAND_TIMEOUT_MS,
          ...(this.smtp.user !== undefined ? { user: this.smtp.user } : {}),
          ...(this.smtp.pass !== undefined ? { pass: this.smtp.pass } : {}),
          ...(this.smtp.allowInsecureAuth === true ? { allowInsecureAuth: true } : {}),
        },
        message,
      );
    } catch (err) {
      // 🔴 错误消息可能内嵌 SMTP 服务端文本，过 redactText 再落；绝不 throw
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[alerts] 邮件通知失败:', redactText(msg));
    }
  }
}

/**
 * 扇出通知器：把一个事件并发派给多个通知器，各自失败互不影响（双保险，成员本身已不抛）。
 * 保持 Notifier 接口不变以兼容 FakeNotifier 与告警引擎注入点。
 */
export class FanoutNotifier implements Notifier {
  private readonly notifiers: Notifier[];

  constructor(notifiers: Notifier[]) {
    this.notifiers = notifiers;
  }

  async fire(event: NotifyEvent): Promise<void> {
    await Promise.all(
      this.notifiers.map((n) =>
        n.fire(event).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[alerts] 通知器执行失败:', redactText(msg));
        }),
      ),
    );
  }
}
