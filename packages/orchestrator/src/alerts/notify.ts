import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { appSettings } from '../db/schema.js';
import { redactText } from '../jobs/engine.js';

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
