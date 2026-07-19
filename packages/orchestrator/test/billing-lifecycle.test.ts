import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import type { SmtpSettings } from '../src/config.js';
import { appSettings, auditEvents, sites, subscriptions, type SubscriptionRow } from '../src/db/schema.js';
import { fromPgTimestamp, toPgTimestamp } from '../src/auth/sessions.js';
import {
  activeSubscription,
  quotaFor,
  subscribeOperator,
  subscriptionState,
} from '../src/billing/service.js';
import {
  PANEL_BASE_URL_SETTINGS_KEY,
  dueReminders,
  renderReminderEmail,
  startBillingSweep,
  type ReminderContext,
} from '../src/billing/sweep.js';
import { makeTestConfig, makeTestDb, makeTestServer, seedOperator, type TestServer } from './helpers.js';

/**
 * 订阅生命周期测试：宽限期边界、扫描收敛幂等、到期提醒各档幂等 + 续费重置、
 * 续费顺延语义、free 回落不影响存量站、假 SMTP 断言邮件内容含计划名与日期。
 */

vi.setConfig({ testTimeout: 30_000 });

const DAY_MS = 86_400_000;

let db: Db;

beforeAll(async () => {
  db = await makeTestDb();
}, 60_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
});

/** 插入一条订阅；endOffsetMs 相对现在的到期偏移（负=已过期） */
async function seedSub(
  operatorId: number,
  opts: { planKey?: string; status?: string; endOffsetMs: number; reminders?: Record<string, string> },
): Promise<SubscriptionRow> {
  const rows = await db.orm
    .insert(subscriptions)
    .values({
      operatorId,
      planKey: opts.planKey ?? 'pro',
      status: opts.status ?? 'active',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() + opts.endOffsetMs)),
      ...(opts.reminders !== undefined ? { remindersSent: opts.reminders } : {}),
    })
    .returning();
  return rows[0]!;
}

const FAKE_SMTP: SmtpSettings = {
  host: '127.0.0.1',
  port: 2525,
  from: 'billing@relay.example.com',
  secure: false,
};

// ---------------------------------------------------------------------------

describe('宽限期边界（activeSubscription / quotaFor / subscriptionState）', () => {
  it('到期瞬间前=active、宽限内=grace、宽限外=expired；配额随之', async () => {
    // 未到期
    const idA = await seedOperator(db, { role: 'operator' });
    await seedSub(idA, { endOffsetMs: 5 * DAY_MS });
    expect(await quotaFor(db, { operatorId: idA, role: 'operator' }, 3)).toBe(5);
    let st = await subscriptionState(db, idA, 3);
    expect(st.phase).toBe('active');
    expect(st.sub).not.toBeNull();
    expect(st.graceEndsAt).not.toBeNull();
    expect(st.daysRemaining).toBe(5);

    // 已过期但在宽限期内（1 天前到期，宽限 3 天）→ grace，配额仍按 pro
    const idB = await seedOperator(db, { role: 'operator' });
    await seedSub(idB, { endOffsetMs: -1 * DAY_MS });
    expect(await quotaFor(db, { operatorId: idB, role: 'operator' }, 3)).toBe(5);
    expect(await activeSubscription(db, idB, 3)).not.toBeNull();
    st = await subscriptionState(db, idB, 3);
    expect(st.phase).toBe('grace');
    expect(st.sub).not.toBeNull();
    expect(st.daysRemaining).toBe(2); // 距宽限结束约 2 天

    // 已过宽限（5 天前到期，宽限 3 天）→ expired，配额回落 free
    const idC = await seedOperator(db, { role: 'operator' });
    await seedSub(idC, { endOffsetMs: -5 * DAY_MS });
    expect(await quotaFor(db, { operatorId: idC, role: 'operator' }, 3)).toBe(1);
    expect(await activeSubscription(db, idC, 3)).toBeNull();
    st = await subscriptionState(db, idC, 3);
    expect(st.phase).toBe('expired');
    expect(st.sub).toBeNull();
  });

  it('grace=0（关闭宽限）：到期即回落 free', async () => {
    const id = await seedOperator(db, { role: 'operator' });
    await seedSub(id, { endOffsetMs: -1 * DAY_MS });
    expect(await quotaFor(db, { operatorId: id, role: 'operator' }, 0)).toBe(1);
    const st = await subscriptionState(db, id, 0);
    expect(st.phase).toBe('expired');
  });

  it('无订阅=none；已取消（未到期）=none（回落 free，非 expired）', async () => {
    const idNone = await seedOperator(db, { role: 'operator' });
    expect((await subscriptionState(db, idNone, 3)).phase).toBe('none');

    const idCancel = await seedOperator(db, { role: 'operator' });
    await seedSub(idCancel, { status: 'cancelled', endOffsetMs: 10 * DAY_MS });
    const st = await subscriptionState(db, idCancel, 3);
    expect(st.phase).toBe('none');
    expect(await quotaFor(db, { operatorId: idCancel, role: 'operator' }, 3)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('续费顺延语义（subscribeOperator）', () => {
  it('到期前续费=在原到期日上顺延，且清空 reminders_sent', async () => {
    const id = await seedOperator(db, { role: 'operator' });
    const orig = await seedSub(id, { endOffsetMs: 10 * DAY_MS, reminders: { t7: '2020-01-01T00:00:00.000Z' } });
    const endMs = fromPgTimestamp(orig.currentPeriodEnd).getTime();

    const updated = await subscribeOperator(db, { operatorId: id, planKey: 'pro', months: 1 });
    expect(updated.id).toBe(orig.id); // 复用同一条
    expect(fromPgTimestamp(updated.currentPeriodEnd).getTime()).toBe(endMs + 30 * DAY_MS);
    expect(updated.remindersSent).toEqual({}); // 续费清空提醒台账
  });

  it('过期后续费=从现在起算（active 但已过期未收敛）', async () => {
    const id = await seedOperator(db, { role: 'operator' });
    await seedSub(id, { endOffsetMs: -5 * DAY_MS });
    const before = Date.now();
    const updated = await subscribeOperator(db, { operatorId: id, planKey: 'pro', months: 1 });
    const newEnd = fromPgTimestamp(updated.currentPeriodEnd).getTime();
    // 从现在起算 +30 天（容忍执行耗时几秒）
    expect(Math.abs(newEnd - (before + 30 * DAY_MS))).toBeLessThan(15_000);
  });

  it('已收敛为 expired 后续费=新建一条，从现在起算', async () => {
    const id = await seedOperator(db, { role: 'operator' });
    await seedSub(id, { status: 'expired', endOffsetMs: -40 * DAY_MS });
    const before = Date.now();
    const created = await subscribeOperator(db, { operatorId: id, planKey: 'pro', months: 2 });
    const newEnd = fromPgTimestamp(created.currentPeriodEnd).getTime();
    expect(Math.abs(newEnd - (before + 60 * DAY_MS))).toBeLessThan(15_000);
    // 该 operator 现有一条 active
    const active = await db.orm
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.operatorId, id), eq(subscriptions.status, 'active')));
    expect(active).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('提醒档判定与渲染（dueReminders / renderReminderEmail）', () => {
  it('dueReminders 命中窗口且跳过已发档', () => {
    const now = Date.now();
    // 到期前 6 天：t7 命中，t1 未到，expiry 未到
    const sub6d = { currentPeriodEnd: toPgTimestamp(new Date(now + 6 * DAY_MS)), remindersSent: {} };
    expect(dueReminders(sub6d, 3, now)).toEqual(['t7']);
    // 已发过 t7 → 不再列入
    const sub6dSent = { currentPeriodEnd: toPgTimestamp(new Date(now + 6 * DAY_MS)), remindersSent: { t7: 'x' } };
    expect(dueReminders(sub6dSent, 3, now)).toEqual([]);
    // 已过期 1 天、宽限 3 天：expiry 命中，graceEnd 未到，t7/t1 越过到期不再发
    const subExpired = { currentPeriodEnd: toPgTimestamp(new Date(now - 1 * DAY_MS)), remindersSent: {} };
    expect(dueReminders(subExpired, 3, now)).toEqual(['expiry']);
    // 已过宽限：expiry + graceEnd 同轮命中
    const subPastGrace = { currentPeriodEnd: toPgTimestamp(new Date(now - 4 * DAY_MS)), remindersSent: {} };
    expect(dueReminders(subPastGrace, 3, now).sort()).toEqual(['expiry', 'graceEnd']);
    // grace=0：graceEnd 与 expiry 重合，不重复
    expect(dueReminders(subExpired, 0, now)).toEqual(['expiry']);
  });

  it('renderReminderEmail 中文，含计划名/到期日期/续费入口', () => {
    const ctx: ReminderContext = {
      planTitle: '专业',
      periodEnd: '2026-07-19 08:00:00',
      graceEndsAt: '2026-07-22 08:00:00',
      renewUrl: 'https://panel.example.com/billing',
    };
    const t7 = renderReminderEmail('t7', ctx);
    expect(t7.subject).toContain('专业');
    expect(t7.subject).toContain('即将到期');
    expect(t7.text).toContain('专业');
    expect(t7.text).toContain('2026-07-19T08:00:00.000Z');
    expect(t7.text).toContain('https://panel.example.com/billing');

    const graceEnd = renderReminderEmail('graceEnd', ctx);
    expect(graceEnd.subject).toContain('宽限期');
    // 存量站不停止的措辞出现
    expect(graceEnd.text).toContain('不会被停止');
    expect(graceEnd.text).toContain('2026-07-22T08:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------

describe('计费扫描循环（startBillingSweep）', () => {
  it('过宽限收敛为 expired（审计 actor=system），跑两遍幂等', async () => {
    const id = await seedOperator(db, { email: 'sweep-conv@example.com', role: 'operator' });
    const sub = await seedSub(id, { endOffsetMs: -4 * DAY_MS }); // 宽限 3 天 → 已过宽限
    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: FAKE_SMTP, send }, 0);

    await sweep.tick();
    const after1 = (await db.orm.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!;
    expect(after1.status).toBe('expired');
    const audits1 = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'billing.expire'), eq(auditEvents.actor, 'system')));
    const mine1 = audits1.filter((a) => (a.payload as { subscriptionId?: number })?.subscriptionId === sub.id);
    expect(mine1).toHaveLength(1);

    // 第二轮：已 expired 不再处理，状态与审计不重复
    await sweep.tick();
    const audits2 = await db.orm
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'billing.expire'), eq(auditEvents.actor, 'system')));
    const mine2 = audits2.filter((a) => (a.payload as { subscriptionId?: number })?.subscriptionId === sub.id);
    expect(mine2).toHaveLength(1);
  });

  it('到期提醒：各档发一次，跑两遍不重发；邮件含计划名与到期日期', async () => {
    const id = await seedOperator(db, { email: 'sweep-remind@example.com', role: 'operator' });
    const sub = await seedSub(id, { planKey: 'pro', endOffsetMs: 6 * DAY_MS }); // t7 窗口内
    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: FAKE_SMTP, send }, 0);

    await sweep.tick();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![1];
    expect(msg.to).toBe('sweep-remind@example.com');
    expect(msg.subject).toContain('专业'); // 计划名
    expect(msg.text).toContain(fromPgTimestamp(sub.currentPeriodEnd).toISOString()); // 到期日期(UTC)
    // 相对路径提示（未配面板公网地址）
    expect(msg.text).toContain('/billing');

    // reminders_sent.t7 已记
    const after = (await db.orm.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!;
    expect(typeof (after.remindersSent as Record<string, string>).t7).toBe('string');

    // 第二轮：t7 已发不再重发
    await sweep.tick();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('续费顺延后 reminders_sent 清空 → 新周期可再次发提醒', async () => {
    const id = await seedOperator(db, { email: 'sweep-renew@example.com', role: 'operator' });
    const sub = await seedSub(id, { planKey: 'pro', endOffsetMs: 6 * DAY_MS });
    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: FAKE_SMTP, send }, 0);

    await sweep.tick();
    expect(send).toHaveBeenCalledTimes(1); // t7

    // 续费顺延（清空 reminders_sent），新到期又落在 t7 窗口内以便复现
    await db.orm
      .update(subscriptions)
      .set({ remindersSent: {}, currentPeriodEnd: toPgTimestamp(new Date(Date.now() + 6 * DAY_MS)) })
      .where(eq(subscriptions.id, sub.id));

    await sweep.tick();
    expect(send).toHaveBeenCalledTimes(2); // 新周期再次发 t7
  });

  it('面板公网地址已配 → 续费入口用绝对地址', async () => {
    await db.orm
      .insert(appSettings)
      .values({ key: PANEL_BASE_URL_SETTINGS_KEY, value: { url: 'https://panel.example.com/' } })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: { url: 'https://panel.example.com/' } } });
    const id = await seedOperator(db, { email: 'sweep-url@example.com', role: 'operator' });
    await seedSub(id, { planKey: 'pro', endOffsetMs: 6 * DAY_MS });
    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: FAKE_SMTP, send }, 0);

    await sweep.tick();
    const msg = send.mock.calls[0]![1];
    expect(msg.text).toContain('https://panel.example.com/billing');

    await db.orm.delete(appSettings).where(eq(appSettings.key, PANEL_BASE_URL_SETTINGS_KEY));
  });

  it('未配 SMTP（smtp=null）：不发信但状态收敛照常', async () => {
    const id = await seedOperator(db, { email: 'sweep-nosmtp@example.com', role: 'operator' });
    const sub = await seedSub(id, { endOffsetMs: -4 * DAY_MS });
    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: null, send }, 0);

    await sweep.tick();
    expect(send).not.toHaveBeenCalled();
    const after = (await db.orm.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!;
    expect(after.status).toBe('expired');
  });

  it('邮件发送失败只 warn 不中断：该档不记，收敛仍进行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await seedOperator(db, { email: 'sweep-fail@example.com', role: 'operator' });
    const sub = await seedSub(id, { endOffsetMs: -4 * DAY_MS }); // expiry + graceEnd 到期
    const send = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:2525');
    });
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: FAKE_SMTP, send }, 0);

    await sweep.tick();
    expect(send).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // 失败档不记 → reminders_sent 仍为空
    const after = (await db.orm.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!;
    expect(after.remindersSent).toEqual({});
    // 但状态仍收敛
    expect(after.status).toBe('expired');
  });

  it('free 回落不影响存量站：扫描不触碰 sites，站点仍在', async () => {
    const id = await seedOperator(db, { email: 'sweep-site@example.com', role: 'operator' });
    await seedSub(id, { endOffsetMs: -4 * DAY_MS });
    const siteRows = await db.orm
      .insert(sites)
      .values({
        operatorId: id,
        slug: `lifecycle-site-${id}`,
        label: '存量站',
        engine: 'sub2api',
        version: 'v1.0.0',
        hostPort: 18990 + id,
        baseUrl: `http://127.0.0.1:${18990 + id}`,
        status: 'active',
      })
      .returning({ id: sites.id });
    const siteId = siteRows[0]!.id;

    const send = vi.fn(async () => undefined);
    const sweep = startBillingSweep({ config: makeTestConfig({ billingGraceDays: 3 }), db, smtp: null, send }, 0);
    await sweep.tick();

    // 配额回落 free，但站点原样存在、状态未变
    expect(await quotaFor(db, { operatorId: id, role: 'operator' }, 3)).toBe(1);
    const site = (await db.orm.select().from(sites).where(eq(sites.id, siteId)))[0]!;
    expect(site.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/billing/subscription 暴露 phase/graceEndsAt/daysRemaining', () => {
  let ts: TestServer;
  let opCookie: string;
  let opId: number;

  beforeAll(async () => {
    ts = await makeTestServer({ config: { billingGraceDays: 3 } });
    const op = await ts.seedLogin({ email: 'phase-op@example.com', password: 'op-pass-1234', role: 'operator' });
    opCookie = op.cookie;
    opId = op.operatorId;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  async function getSub(): Promise<Record<string, unknown>> {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      cookies: { rp_session: opCookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  }

  it('无订阅 → phase none', async () => {
    const body = await getSub();
    expect(body.phase).toBe('none');
    expect(body.graceEndsAt).toBeNull();
    expect(body.daysRemaining).toBeNull();
  });

  it('宽限期订阅 → phase grace，配额仍按 pro，graceEndsAt/daysRemaining 有值', async () => {
    await ts.db.orm.insert(subscriptions).values({
      operatorId: opId,
      planKey: 'pro',
      currentPeriodEnd: toPgTimestamp(new Date(Date.now() - 1 * DAY_MS)),
    });
    const body = await getSub();
    expect(body.phase).toBe('grace');
    expect(body.quota).toBe(5);
    expect(body.graceEndsAt).not.toBeNull();
    expect(typeof body.daysRemaining).toBe('number');
    expect(body.currentPeriodEnd).not.toBeNull();
  });
});

describe('GET/PUT /api/settings/billing（root 配置面板公网地址）', () => {
  let ts: TestServer;
  let rootCookie: string;
  let opCookie: string;

  beforeAll(async () => {
    ts = await makeTestServer();
    const root = await ts.seedLogin({ email: 'bset-root@example.com', password: 'root-pass-1234', role: 'root' });
    rootCookie = root.cookie;
    const op = await ts.seedLogin({ email: 'bset-op@example.com', password: 'op-pass-1234', role: 'operator' });
    opCookie = op.cookie;
  }, 60_000);

  afterAll(async () => {
    await ts.close();
  });

  it('非 root 禁止读写', async () => {
    const g = await ts.app.inject({ method: 'GET', url: '/api/settings/billing', cookies: { rp_session: opCookie } });
    expect(g.statusCode).toBe(403);
    const p = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/billing',
      cookies: { rp_session: opCookie },
      payload: { panelBaseUrl: 'https://x.example.com' },
    });
    expect(p.statusCode).toBe(403);
  });

  it('root 设置/清除面板公网地址，非法地址 400', async () => {
    const bad = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/billing',
      cookies: { rp_session: rootCookie },
      payload: { panelBaseUrl: 'ftp://nope' },
    });
    expect(bad.statusCode).toBe(400);

    const set = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/billing',
      cookies: { rp_session: rootCookie },
      payload: { panelBaseUrl: 'https://panel.example.com' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { panelBaseUrl: string }).panelBaseUrl).toBe('https://panel.example.com');

    const get = await ts.app.inject({ method: 'GET', url: '/api/settings/billing', cookies: { rp_session: rootCookie } });
    expect((get.json() as { panelBaseUrl: string; graceDays: number }).panelBaseUrl).toBe('https://panel.example.com');
    expect((get.json() as { graceDays: number }).graceDays).toBe(3);

    const clear = await ts.app.inject({
      method: 'PUT',
      url: '/api/settings/billing',
      cookies: { rp_session: rootCookie },
      payload: { panelBaseUrl: '' },
    });
    expect((clear.json() as { panelBaseUrl: string | null }).panelBaseUrl).toBeNull();
  });
});
