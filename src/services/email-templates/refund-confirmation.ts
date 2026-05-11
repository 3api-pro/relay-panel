import { Brand, brandShell, escapeHtml } from './brand';

export interface RefundConfirmationData {
  order_id: number;
  amount_cents: number;
  currency: string;
  reason: string | null;
}

function money(cents: number, currency: string): string {
  return (cents / 100).toFixed(2) + ' ' + currency;
}

export function renderRefundConfirmation(brand: Brand, d: RefundConfirmationData): { subject: string; html: string; text: string } {
  const inner = [
    '<h2 style="margin-top:0;">Refund processed</h2>',
    '<p>We have processed a refund of <b>' + money(d.amount_cents, d.currency) + '</b> for order <b>#' + d.order_id + '</b>.</p>',
    d.reason ? '<p>Reason: <i>' + escapeHtml(d.reason) + '</i></p>' : '',
    '<p>The amount should arrive back to your original payment method within 3-7 business days, depending on your bank.</p>',
    '<p>If the refund does not arrive in that window, reply to this email and we will follow up.</p>',
  ].filter(Boolean).join('\n');
  return {
    subject: '[' + brand.store_name + '] Refund confirmed — Order #' + d.order_id,
    html: brandShell(brand, inner),
    text: 'Refund of ' + money(d.amount_cents, d.currency) + ' processed for order #' + d.order_id + (d.reason ? '. Reason: ' + d.reason : ''),
  };
}
