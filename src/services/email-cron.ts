/**
 * Email cron — periodic background jobs:
 *   1. Subscription expiring soon (3 days out) — daily sweep, ~03:00 UTC.
 *   2. Wholesale balance low (< 50 CNY)        — every 30 min, throttled
 *      to one warning per tenant per 24h.
 *
 * Both jobs use a single setInterval ticker that decides what to run
 * based on the current minute, so we don't need a real cron library.
 *
 * Disable via EMAIL_CRON_ENABLED=off.
 */
import { config } from "../config";
import { query } from "./database";
import { logger } from "./logger";
import { sendEmail } from "./email-resend";

const TICK_MS = 60_000; // every minute
const LOW_BALANCE_THRESHOLD_CENTS = 5000; // ¥50
let timer: NodeJS.Timeout | null = null;
let lastExpiringSweepDay = "";
let lastLowSweepHalfHour = "";

export async function sweepExpiringSubscriptions(): Promise<number> {
  const rows = await query<any>(
    `SELECT s.id, s.tenant_id, s.end_user_id, s.plan_name, s.expires_at,
            u.email
       FROM subscription s
       JOIN end_user u ON u.id = s.end_user_id
      WHERE s.status = 'active'
        AND s.reminder_sent_at IS NULL
        AND s.expires_at BETWEEN NOW() + interval '3 days' AND NOW() + interval '4 days'
        AND u.email IS NOT NULL
      LIMIT 500`,
  );
  let sent = 0;
  for (const r of rows) {
    try {
      const result = await sendEmail({
        to: r.email,
        template: "subscription-expiring",
        tenantId: r.tenant_id,
        data: {
          plan_name: r.plan_name,
          expires_at: r.expires_at,
          days_left: 3,
        },
      });
      if (result.ok) {
        await query(`UPDATE subscription SET reminder_sent_at = NOW() WHERE id = $1`, [r.id]);
        sent++;
      }
    } catch (err: any) {
      logger.warn({ err: err.message, subscriptionId: r.id }, "email-cron:expiring:err");
    }
  }
  if (sent > 0) logger.info({ sent }, "email-cron:expiring:swept");
  return sent;
}

export async function sweepLowWholesale(): Promise<number> {
  const rows = await query<any>(
    `SELECT w.tenant_id, w.balance_cents,
            t.slug,
            (SELECT bc.contact_email FROM brand_config bc WHERE bc.tenant_id = w.tenant_id LIMIT 1) AS contact_email
       FROM wholesale_balance w
       JOIN tenant t ON t.id = w.tenant_id
      WHERE w.balance_cents < $1
        AND (w.low_warning_sent_at IS NULL OR w.low_warning_sent_at < NOW() - interval '24 hours')
      LIMIT 100`,
    [LOW_BALANCE_THRESHOLD_CENTS],
  );
  let sent = 0;
  for (const r of rows) {
    if (!r.contact_email) continue;
    try {
      const result = await sendEmail({
        to: r.contact_email,
        template: "wholesale-low",
        tenantId: r.tenant_id,
        data: {
          balance_cents: Number(r.balance_cents),
          currency: "CNY",
          tenant_slug: r.slug,
        },
      });
      if (result.ok) {
        await query(`UPDATE wholesale_balance SET low_warning_sent_at = NOW() WHERE tenant_id = $1`, [r.tenant_id]);
        sent++;
      }
    } catch (err: any) {
      logger.warn({ err: err.message, tenantId: r.tenant_id }, "email-cron:low:err");
    }
  }
  if (sent > 0) logger.info({ sent }, "email-cron:low:swept");
  return sent;
}

async function tick(): Promise<void> {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  // Run expiring sweep once per day at any tick after 03:00 UTC.
  if (now.getUTCHours() >= 3 && lastExpiringSweepDay !== dayKey) {
    lastExpiringSweepDay = dayKey;
    await sweepExpiringSubscriptions().catch((e) =>
      logger.error({ err: e.message }, "email-cron:expiring:tick:err"),
    );
  }
  // Run low-wholesale sweep on a 30-min cadence.
  const halfHourKey = dayKey + "_" + now.getUTCHours() + "_" + (now.getUTCMinutes() < 30 ? 0 : 1);
  if (lastLowSweepHalfHour !== halfHourKey) {
    lastLowSweepHalfHour = halfHourKey;
    await sweepLowWholesale().catch((e) =>
      logger.error({ err: e.message }, "email-cron:low:tick:err"),
    );
  }
}

export function startEmailCron(): void {
  if (!config.emailCronEnabled) {
    logger.info("email-cron:disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  logger.info({ tickMs: TICK_MS }, "email-cron:started");
}

export function stopEmailCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
