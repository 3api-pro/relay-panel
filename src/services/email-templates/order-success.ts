import { Brand, brandShell, escapeHtml, btn } from './brand';

export interface OrderSuccessData {
  plan_name: string;
  amount_cents: number;
  currency: string;
  raw_key: string;
  expires_at: string;
  order_id: number;
}

function money(cents: number, currency: string): string {
  return (cents / 100).toFixed(2) + ' ' + currency;
}

export function renderOrderSuccess(brand: Brand, d: OrderSuccessData): { subject: string; html: string; text: string } {
  const dashUrl = brand.public_base_url.replace(/\/+$/, '') + '/dashboard';
  const inner = [
    '<h2 style="margin-top:0;">Payment received — thank you!</h2>',
    '<p>Your order <b>#' + d.order_id + '</b> is complete. Plan <b>' + escapeHtml(d.plan_name) + '</b> for ' + money(d.amount_cents, d.currency) + ' is now active until <b>' + escapeHtml(new Date(d.expires_at).toUTCString()) + '</b>.</p>',
    '<div style="background:#f5f5f7;border-radius:8px;padding:14px;margin:18px 0;">',
    '  <div style="color:#888;font-size:12px;margin-bottom:4px;">Your API key:</div>',
    '  <code style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;">' + escapeHtml(d.raw_key) + '</code>',
    '</div>',
    '<p style="color:#a44;font-size:13px;">Save this key now — we cannot show it again.</p>',
    '<p style="text-align:center;margin:24px 0;">' + btn(dashUrl, 'Open dashboard', brand.primary_color) + '</p>',
  ].join('\n');
  return {
    subject: '[' + brand.store_name + '] Order #' + d.order_id + ' paid — your API key is ready',
    html: brandShell(brand, inner),
    text: 'Order #' + d.order_id + ' paid. API key: ' + d.raw_key + ' . Save it now. ' + dashUrl,
  };
}
