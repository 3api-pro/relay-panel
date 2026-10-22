import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { notifications, notificationPreferences, operators } from '../db/schema.js';
import { encryptSecret, decryptSecret } from '../secrets.js';
import { fromPgTimestamp, toPgTimestamp } from '../auth/sessions.js';
import { EmailNotifier } from '../alerts/notify.js';
import type { SmtpSend } from '../alerts/smtp.js';

export async function queueNotification(db: Db, config: Config, input: {
  operatorId: number; category: 'security' | 'alerts' | 'billing' | 'support';
  key: string; subject: string; body: string; privateMail?: string; expiresAt?: string;
}): Promise<void> {
  if (input.privateMail && !config.secretKey) throw new Error('Account mail requires RP_SECRET_KEY');
  await db.orm.insert(notifications).values({
    operatorId: input.operatorId, category: input.category, dedupeKey: input.key,
    subject: input.subject, body: input.body,
    ...(input.privateMail ? { mailCiphertext: encryptSecret(input.privateMail, config.secretKey!) } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  }).onConflictDoNothing({ target: notifications.dedupeKey });
}

/** Lease each delivery; retries are bounded. SMTP is at-least-once across a crash after DATA. */
export async function deliverNotifications(db: Db, config: Config, send?: SmtpSend): Promise<{ sent: number; failed: number }> {
  const now = toPgTimestamp(new Date());
  await db.orm.update(notifications).set({ status: 'expired', mailCiphertext: null })
    .where(and(inArray(notifications.status, ['pending', 'sending']), lt(notifications.expiresAt, now)));
  const due = await db.orm.select().from(notifications).where(and(
    inArray(notifications.status, ['pending', 'sending']), lt(notifications.nextAttemptAt, now),
  )).orderBy(notifications.id).limit(25);
  let sent = 0, failed = 0;
  const mailer = new EmailNotifier(db, config.smtp ?? null, send);
  for (const item of due) {
    const [claimed] = await db.orm.update(notifications).set({ status: 'sending',
      attempts: sql`${notifications.attempts} + 1`, nextAttemptAt: toPgTimestamp(new Date(Date.now() + 300_000)),
    }).where(and(eq(notifications.id, item.id), eq(notifications.attempts, item.attempts), lt(notifications.nextAttemptAt, now)))
      .returning({ id: notifications.id });
    if (!claimed) continue;
    const [owner] = await db.orm.select().from(operators).where(eq(operators.id, item.operatorId));
    const [prefs] = await db.orm.select().from(notificationPreferences).where(eq(notificationPreferences.operatorId, item.operatorId));
    const optedOut = item.category !== 'security' && prefs && prefs[item.category as 'alerts' | 'billing' | 'support'] === false;
    if (!owner || owner.status !== 'active' || optedOut || (item.category !== 'security' && !owner.emailVerifiedAt)) {
      await db.orm.update(notifications).set({ status: 'skipped', mailCiphertext: null }).where(eq(notifications.id, item.id));
      continue;
    }
    let ok = false;
    try {
      const body = item.mailCiphertext ? decryptSecret(item.mailCiphertext, config.secretKey ?? '') : item.body;
      ok = (await mailer.sendDirect([owner.email], item.subject, body)) === 1;
    } catch { /* No transport or secret material is persisted in errors. */ }
    const attempts = item.attempts + 1;
    await db.orm.update(notifications).set(ok ? {
      status: 'sent', mailCiphertext: null, lastError: null,
    } : {
      status: attempts >= 6 ? 'failed' : 'pending', lastError: config.smtp ? '邮件投递失败，请检查 SMTP' : 'SMTP 未配置',
      nextAttemptAt: toPgTimestamp(new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** attempts))),
      ...(attempts >= 6 ? { mailCiphertext: null } : {}),
    }).where(eq(notifications.id, item.id));
    if (ok) sent++; else failed++;
  }
  return { sent, failed };
}
