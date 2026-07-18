import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  credentials,
  operators,
  paymentOrders,
  paymentProviders,
  type PaymentOrderRow,
  type PaymentProviderRow,
} from '../../db/schema.js';
import { ApiError, requireRoot, type SessionCtx } from '../../auth/rbac.js';
import { fromPgTimestamp, toPgTimestamp } from '../../auth/sessions.js';
import { writeAudit } from '../../audit.js';
import { decryptSecret, encryptSecret } from '../../secrets.js';
import { planByKey, subscribeOperator } from '../service.js';
import { AlipayGateway } from './alipay.js';
import { WxpayGateway } from './wxpay.js';
import { ChainpayGateway } from './chainpay.js';
import { KNOWN_PROVIDER_KEYS, PROVIDER_REQUIRED_KEYS, type PaymentGateway, type WebhookHeaders } from './types.js';

/**
 * 收款服务（P4 支付接入）。
 * 订单状态机：pending -> paid -> completed；终态 expired|failed|cancelled。
 * 入账唯一路径 confirmOrder：主动向渠道查单，条件 UPDATE(status='pending') 抢占后才开通订阅
 * —— webhook 与前端轮询都只是它的触发器，天然幂等，重复通知/并发轮询不会双开。
 * 纪律：渠道 config 只以密文存 credentials 表；任何出口（API 响应/审计/日志）不带 config 值。
 */

const ORDER_TTL_MS = 30 * 60_000;
const CONFIRM_MIN_INTERVAL_MS = 3000;
const MAX_PENDING_PER_OPERATOR = 5;

/** 每单查渠道限速（防前端高频轮询打爆渠道 API）；key=orderNo */
const confirmGate = new Map<string, number>();

export interface PaymentsServiceDeps {
  config: Config;
  db: Db;
}

export interface CheckoutInput {
  planKey: string;
  months: number;
  providerKey: string;
}

/** 对外订单形状（operator 可见自己的；root 全量） */
export interface OrderView {
  orderNo: string;
  planKey: string;
  months: number;
  amount: number;
  providerKey: string;
  status: string;
  payUrl: string | null;
  qrCode: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

function toOrderView(row: PaymentOrderRow): OrderView {
  return {
    orderNo: row.orderNo,
    planKey: row.planKey,
    months: row.months,
    amount: row.amount,
    providerKey: row.providerKey,
    status: row.status,
    payUrl: row.payUrl,
    qrCode: row.qrCode,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

function nowPg(): string {
  return toPgTimestamp(new Date());
}

function newOrderNo(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `RP${stamp}${randomBytes(4).toString('hex').toUpperCase()}`;
}

export class PaymentsService {
  constructor(private readonly deps: PaymentsServiceDeps) {}

  // ---- 渠道配置（root） ----

  /** upsert 渠道；config 加密入 credentials 表（ref=enc:payment:<key>），值绝不回读 */
  async upsertProvider(
    ctx: SessionCtx,
    input: { key: string; name: string; enabled: boolean; sortOrder: number; paymentMode: string; config?: Record<string, string> },
  ): Promise<void> {
    requireRoot(ctx);
    const { db, config } = this.deps;
    if (!KNOWN_PROVIDER_KEYS.includes(input.key)) throw new ApiError(400, `不支持的收款渠道: ${input.key}`);

    const existing = (
      await db.orm.select().from(paymentProviders).where(eq(paymentProviders.key, input.key)).limit(1)
    )[0];
    const ref = `enc:payment:${input.key}`;

    if (input.config !== undefined) {
      if (config.secretKey === undefined) throw new ApiError(400, 'RP_SECRET_KEY 未配置，无法保存渠道凭据');
      const missing = PROVIDER_REQUIRED_KEYS[input.key]!.filter((k) => !input.config![k]?.trim());
      if (missing.length > 0) throw new ApiError(400, `渠道配置缺少必填项: ${missing.join(', ')}`);
      const ciphertext = encryptSecret(JSON.stringify(input.config), config.secretKey);
      await db.orm
        .insert(credentials)
        .values({ ref, kind: 'payment', ciphertext })
        .onConflictDoUpdate({ target: credentials.ref, set: { ciphertext, rotatedAt: nowPg() } });
    } else if (!existing) {
      throw new ApiError(400, '首次保存渠道必须提供 config');
    }

    const fields = {
      name: input.name,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
      paymentMode: input.paymentMode,
      configRef: ref,
      updatedAt: nowPg(),
    };
    if (existing) {
      await db.orm.update(paymentProviders).set(fields).where(eq(paymentProviders.id, existing.id));
    } else {
      await db.orm.insert(paymentProviders).values({ key: input.key, ...fields });
    }
    await writeAudit(db, {
      actor: ctx.email,
      action: 'payment.provider.upsert',
      payload: { provider: input.key, enabled: input.enabled, configUpdated: input.config !== undefined },
      ok: true,
    });
  }

  /** root 视图：含 config 键名（不含值）便于核对配置齐不齐 */
  async listProviders(ctx: SessionCtx): Promise<
    Array<{ key: string; name: string; enabled: boolean; sortOrder: number; paymentMode: string; configKeys: string[] }>
  > {
    requireRoot(ctx);
    const rows = await this.deps.db.orm.select().from(paymentProviders).orderBy(paymentProviders.sortOrder);
    return Promise.all(
      rows.map(async (row) => {
        let configKeys: string[] = [];
        try {
          configKeys = Object.keys(await this.loadProviderConfig(row));
        } catch {
          // 解密失败（换过 RP_SECRET_KEY 等）→ 键名列表留空，前端提示重新保存
        }
        return {
          key: row.key,
          name: row.name,
          enabled: row.enabled,
          sortOrder: row.sortOrder,
          paymentMode: row.paymentMode,
          configKeys,
        };
      }),
    );
  }

  async deleteProvider(ctx: SessionCtx, key: string): Promise<void> {
    requireRoot(ctx);
    const { db } = this.deps;
    const row = (await db.orm.select().from(paymentProviders).where(eq(paymentProviders.key, key)).limit(1))[0];
    if (!row) throw new ApiError(404, '渠道不存在');
    await db.orm.delete(paymentProviders).where(eq(paymentProviders.id, row.id));
    await db.orm.delete(credentials).where(eq(credentials.ref, row.configRef));
    await writeAudit(db, { actor: ctx.email, action: 'payment.provider.delete', payload: { provider: key }, ok: true });
  }

  /** operator 可见的支付方式（enabled 序） */
  async listMethods(): Promise<Array<{ key: string; name: string; paymentMode: string }>> {
    const rows = await this.deps.db.orm
      .select()
      .from(paymentProviders)
      .where(eq(paymentProviders.enabled, true))
      .orderBy(paymentProviders.sortOrder);
    return rows.map((r) => ({ key: r.key, name: r.name, paymentMode: r.paymentMode }));
  }

  // ---- 网关装配 ----

  private async loadProviderConfig(row: PaymentProviderRow): Promise<Record<string, string>> {
    const { db, config } = this.deps;
    if (config.secretKey === undefined) throw new ApiError(400, 'RP_SECRET_KEY 未配置');
    const cred = (await db.orm.select().from(credentials).where(eq(credentials.ref, row.configRef)).limit(1))[0];
    if (!cred) throw new ApiError(500, '渠道凭据缺失，请重新保存渠道配置');
    return JSON.parse(decryptSecret(cred.ciphertext, config.secretKey)) as Record<string, string>;
  }

  private async gatewayFor(providerKey: string): Promise<{ gateway: PaymentGateway; row: PaymentProviderRow }> {
    const row = (
      await this.deps.db.orm.select().from(paymentProviders).where(eq(paymentProviders.key, providerKey)).limit(1)
    )[0];
    if (!row || !row.enabled) throw new ApiError(400, '收款渠道未启用');
    const cfg = await this.loadProviderConfig(row);
    switch (providerKey) {
      case 'alipay':
        return { gateway: new AlipayGateway(cfg, row.paymentMode), row };
      case 'wxpay':
        return { gateway: new WxpayGateway(cfg), row };
      case 'usdt':
        return { gateway: new ChainpayGateway(cfg), row };
      default:
        throw new ApiError(400, `不支持的收款渠道: ${providerKey}`);
    }
  }

  // ---- 下单 / 查单 / 入账 ----

  async createCheckout(ctx: SessionCtx, input: CheckoutInput): Promise<OrderView> {
    const { db } = this.deps;
    if (ctx.role === 'viewer') throw new ApiError(403, '当前角色为只读，无写权限');
    const plan = await planByKey(db, input.planKey);
    if (!plan || !plan.active) throw new ApiError(404, '套餐不存在');
    if (plan.priceMonthly <= 0) throw new ApiError(400, '免费套餐无需购买');

    // 防挂单堆积：同人 pending 上限（顺手把过期单收敛掉）
    await this.expireStale(ctx.operatorId);
    const pendingRows = await db.orm
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.operatorId, ctx.operatorId), eq(paymentOrders.status, 'pending')));
    if (pendingRows.length >= MAX_PENDING_PER_OPERATOR) {
      throw new ApiError(429, '待支付订单过多，请先完成或取消现有订单');
    }

    const { gateway } = await this.gatewayFor(input.providerKey);
    const amount = Math.round(plan.priceMonthly * input.months * 100) / 100;
    const orderNo = newOrderNo();
    const expiresAt = toPgTimestamp(new Date(Date.now() + ORDER_TTL_MS));

    await db.orm.insert(paymentOrders).values({
      orderNo,
      operatorId: ctx.operatorId,
      planKey: plan.key,
      months: input.months,
      amount,
      providerKey: input.providerKey,
      status: 'pending',
      expiresAt,
    });

    try {
      const created = await gateway.create({ orderNo, amountCny: amount, subject: `relay-panel ${plan.title} x${input.months}` });
      await db.orm
        .update(paymentOrders)
        .set({
          payUrl: created.payUrl ?? null,
          qrCode: created.qrCode ?? null,
          providerTradeNo: created.tradeNo ?? null,
          updatedAt: nowPg(),
        })
        .where(eq(paymentOrders.orderNo, orderNo));
    } catch (err) {
      await db.orm
        .update(paymentOrders)
        .set({ status: 'failed', detail: { error: err instanceof Error ? err.message : String(err) }, updatedAt: nowPg() })
        .where(eq(paymentOrders.orderNo, orderNo));
      await writeAudit(db, {
        actor: ctx.email,
        action: 'payment.checkout',
        payload: { orderNo, plan: plan.key, months: input.months, provider: input.providerKey, amount },
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ApiError(502, '渠道建单失败，请稍后重试或换一种支付方式');
    }

    await writeAudit(db, {
      actor: ctx.email,
      action: 'payment.checkout',
      payload: { orderNo, plan: plan.key, months: input.months, provider: input.providerKey, amount },
      ok: true,
    });
    return toOrderView((await this.orderByNo(orderNo))!);
  }

  /**
   * 查单（前端轮询入口）。pending 单触发向渠道核实（每单 3s 限速）；
   * 过期未付标 expired。owner 或 root 可见。
   */
  async getOrder(ctx: SessionCtx, orderNo: string): Promise<OrderView> {
    const row = await this.orderByNo(orderNo);
    if (!row || (ctx.role !== 'root' && row.operatorId !== ctx.operatorId)) throw new ApiError(404, '订单不存在');
    if (row.status === 'pending') {
      const last = confirmGate.get(orderNo) ?? 0;
      if (Date.now() - last >= CONFIRM_MIN_INTERVAL_MS) {
        confirmGate.set(orderNo, Date.now());
        await this.confirmOrder(orderNo).catch(() => undefined); // 渠道抖动不影响轮询本身
      }
    }
    return toOrderView((await this.orderByNo(orderNo))!);
  }

  async cancelOrder(ctx: SessionCtx, orderNo: string): Promise<OrderView> {
    const { db } = this.deps;
    const row = await this.orderByNo(orderNo);
    if (!row || (ctx.role !== 'root' && row.operatorId !== ctx.operatorId)) throw new ApiError(404, '订单不存在');
    // 条件更新抢占：只有仍 pending 的单能取消（并发下已入账的单不会被标取消）
    await db.orm
      .update(paymentOrders)
      .set({ status: 'cancelled', updatedAt: nowPg() })
      .where(and(eq(paymentOrders.orderNo, orderNo), eq(paymentOrders.status, 'pending')));
    return toOrderView((await this.orderByNo(orderNo))!);
  }

  async listOrders(ctx: SessionCtx, all: boolean): Promise<Array<OrderView & { operatorEmail?: string }>> {
    const { db } = this.deps;
    if (all) {
      requireRoot(ctx);
      const rows = await db.orm
        .select({ order: paymentOrders, operatorEmail: operators.email })
        .from(paymentOrders)
        .innerJoin(operators, eq(paymentOrders.operatorId, operators.id))
        .orderBy(desc(paymentOrders.id))
        .limit(200);
      return rows.map((r) => ({ ...toOrderView(r.order), operatorEmail: r.operatorEmail }));
    }
    const rows = await db.orm
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.operatorId, ctx.operatorId))
      .orderBy(desc(paymentOrders.id))
      .limit(50);
    return rows.map(toOrderView);
  }

  /**
   * 入账唯一路径：渠道查单确认已付 → 条件 UPDATE 抢占 pending → 开通订阅 → completed。
   * 抢占失败（并发已处理）直接返回，幂等。开通订阅失败时单停在 paid，人工可见可补。
   */
  async confirmOrder(orderNo: string): Promise<void> {
    const { db } = this.deps;
    const row = await this.orderByNo(orderNo);
    if (!row || row.status !== 'pending') return;

    const { gateway } = await this.gatewayFor(row.providerKey);
    const status = await gateway.query(row.orderNo, row.providerTradeNo);

    if (status === 'paid') {
      const claimed = await db.orm
        .update(paymentOrders)
        .set({ status: 'paid', paidAt: nowPg(), updatedAt: nowPg() })
        .where(and(eq(paymentOrders.orderNo, orderNo), eq(paymentOrders.status, 'pending')))
        .returning({ id: paymentOrders.id });
      if (claimed.length === 0) return; // 并发已被处理

      const op = (await db.orm.select().from(operators).where(eq(operators.id, row.operatorId)).limit(1))[0];
      try {
        const sub = await subscribeOperator(db, { operatorId: row.operatorId, planKey: row.planKey, months: row.months });
        await db.orm
          .update(paymentOrders)
          .set({ status: 'completed', completedAt: nowPg(), updatedAt: nowPg() })
          .where(eq(paymentOrders.orderNo, orderNo));
        await writeAudit(db, {
          actor: 'system',
          action: 'payment.completed',
          payload: {
            orderNo,
            operatorEmail: op?.email ?? String(row.operatorId),
            plan: row.planKey,
            months: row.months,
            amount: row.amount,
            provider: row.providerKey,
            periodEnd: sub.currentPeriodEnd,
          },
          ok: true,
        });
      } catch (err) {
        // 已收款但开通失败：停在 paid，root 订单列表可见，人工重试/补开
        await writeAudit(db, {
          actor: 'system',
          action: 'payment.completed',
          payload: { orderNo, plan: row.planKey, provider: row.providerKey },
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (status === 'expired' || status === 'failed') {
      await db.orm
        .update(paymentOrders)
        .set({ status, updatedAt: nowPg() })
        .where(and(eq(paymentOrders.orderNo, orderNo), eq(paymentOrders.status, 'pending')));
      return;
    }

    // pending：本地超时标 expired（渠道侧订单自然过期，无须去关单）
    if (row.expiresAt !== null && fromPgTimestamp(row.expiresAt).getTime() < Date.now()) {
      await db.orm
        .update(paymentOrders)
        .set({ status: 'expired', updatedAt: nowPg() })
        .where(and(eq(paymentOrders.orderNo, orderNo), eq(paymentOrders.status, 'pending')));
    }
  }

  /** webhook 入口：验签定位订单 → confirmOrder（入账仍以查单为准）。返回渠道要求的应答 */
  async handleWebhook(
    providerKey: string,
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<{ contentType: string; body: string }> {
    const { gateway } = await this.gatewayFor(providerKey);
    const parsed = await gateway.parseWebhook(rawBody, headers);
    await this.confirmOrder(parsed.orderNo);
    return parsed.ack ?? { contentType: 'application/json', body: JSON.stringify({ ok: true }) };
  }

  // ---- 内部 ----

  private async orderByNo(orderNo: string): Promise<PaymentOrderRow | undefined> {
    return (
      await this.deps.db.orm.select().from(paymentOrders).where(eq(paymentOrders.orderNo, orderNo)).limit(1)
    )[0];
  }

  /** 该 operator 的超时 pending 单批量标 expired（下单前顺手清理） */
  private async expireStale(operatorId: number): Promise<void> {
    const { db } = this.deps;
    const rows = await db.orm
      .select({ id: paymentOrders.id, expiresAt: paymentOrders.expiresAt })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.operatorId, operatorId), eq(paymentOrders.status, 'pending')));
    const staleIds = rows
      .filter((r) => r.expiresAt !== null && fromPgTimestamp(r.expiresAt).getTime() < Date.now())
      .map((r) => r.id);
    if (staleIds.length > 0) {
      await db.orm
        .update(paymentOrders)
        .set({ status: 'expired', updatedAt: nowPg() })
        .where(and(inArray(paymentOrders.id, staleIds), eq(paymentOrders.status, 'pending')));
    }
  }
}
