/**
 * Webhook event payload builders.
 *
 * These produce the JSON body that webhook subscribers receive. The wire
 * format is intentionally stable - new fields are additive. Existing
 * fields must never change shape without bumping a version field.
 *
 * All payloads include:
 *   - event_type   (string)
 *   - timestamp    (unix epoch seconds)
 *   - tenant_id    (the source tenant)
 */

export interface OrderPaidPayload {
  event_type: 'order.paid';
  timestamp: number;
  tenant_id: number;
  order: {
    id: number;
    end_user_id: number;
    plan_id: number | null;
    amount_cents: number;
    currency: string | null;
    payment_provider: string | null;
    provider_txn_id: string | null;
    paid_at: string | null;
  };
  end_user?: { id: number; email: string | null };
  plan?: { id: number; name: string | null; slug: string | null };
  tenant: { id: number; slug: string | null };
}

export interface SubscriptionExpiredPayload {
  event_type: 'subscription.expired';
  timestamp: number;
  tenant_id: number;
  subscription: {
    id: number;
    end_user_id: number;
    plan_id: number | null;
    plan_name: string | null;
    period_end: string | null;
    expires_at: string | null;
  };
  end_user?: { id: number; email: string | null };
  tenant: { id: number; slug: string | null };
}

export interface RefundProcessedPayload {
  event_type: 'refund.processed';
  timestamp: number;
  tenant_id: number;
  refund: {
    id: number;
    order_id: number;
    amount_cents: number;
    reason: string;
  };
  order: { id: number; amount_cents: number; status: string };
  end_user?: { id: number; email: string | null };
  tenant: { id: number; slug: string | null };
}

export interface WholesaleLowPayload {
  event_type: 'wholesale.low';
  timestamp: number;
  tenant_id: number;
  wholesale: {
    balance_cents: number;
    threshold_cents: number;
  };
  tenant: { id: number; slug: string | null };
}

export type WebhookEventType =
  | 'order.paid'
  | 'subscription.expired'
  | 'refund.processed'
  | 'wholesale.low'
  | 'test';

export const SUPPORTED_EVENT_TYPES: WebhookEventType[] = [
  'order.paid',
  'subscription.expired',
  'refund.processed',
  'wholesale.low',
];

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
