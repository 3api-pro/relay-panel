import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { notificationPreferences, notifications } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';

export function registerNotificationRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }): void {
  app.get('/api/notifications/preferences', async req => {
    const [prefs] = await db.orm.select().from(notificationPreferences).where(eq(notificationPreferences.operatorId, req.ctx!.operatorId));
    return { preferences: prefs ?? { alerts: true, billing: true, support: true }, emailAvailable: !!config.smtp };
  });
  app.put('/api/notifications/preferences', async req => {
    const parsed = z.object({ alerts: z.boolean(), billing: z.boolean(), support: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, '通知设置无效');
    const value = { ...parsed.data, updatedAt: toPgTimestamp(new Date()) };
    await db.orm.insert(notificationPreferences).values({ operatorId: req.ctx!.operatorId, ...value })
      .onConflictDoUpdate({ target: notificationPreferences.operatorId, set: value });
    await writeAudit(db, { actor: req.ctx!.email, action: 'notifications.preferences', payload: parsed.data, ok: true });
    return { ok: true };
  });
  app.get('/api/notifications', async req => {
    // Explicit projection: encrypted security links must never appear in the inbox API.
    return { notifications: await db.orm.select({ id: notifications.id, category: notifications.category, subject: notifications.subject,
      body: notifications.body, status: notifications.status, readAt: notifications.readAt, createdAt: notifications.createdAt,
    }).from(notifications).where(eq(notifications.operatorId, req.ctx!.operatorId)).orderBy(desc(notifications.id)).limit(100) };
  });
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async req => {
    await db.orm.update(notifications).set({ readAt: toPgTimestamp(new Date()) }).where(and(eq(notifications.id, Number(req.params.id)),
      eq(notifications.operatorId, req.ctx!.operatorId), isNull(notifications.readAt)));
    return { ok: true };
  });
}
