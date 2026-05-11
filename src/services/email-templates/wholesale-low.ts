import { Brand, brandShell, escapeHtml, btn } from './brand';

export interface WholesaleLowData {
  balance_cents: number;
  currency: string;
  tenant_slug: string;
}

function money(cents: number, currency: string): string {
  return (cents / 100).toFixed(2) + ' ' + currency;
}

export function renderWholesaleLow(brand: Brand, d: WholesaleLowData): { subject: string; html: string; text: string } {
  const adminUrl = brand.public_base_url.replace(/\/+$/, '') + '/admin/wholesale';
  const inner = [
    '<h2 style="margin-top:0;color:#c0392b;">Wholesale balance is low</h2>',
    '<p>Your tenant <b>' + escapeHtml(d.tenant_slug) + '</b> has only <b>' + money(d.balance_cents, d.currency) + '</b> left in wholesale credit.</p>',
    '<p>New customer orders will be flagged <code>paid_pending_provision</code> until you top up.</p>',
    '<p style="text-align:center;margin:24px 0;">' + btn(adminUrl, 'Top up now', brand.primary_color) + '</p>',
    '<p style="color:#888;font-size:12px;">This warning is rate-limited to once every 24 hours per tenant.</p>',
  ].join('\n');
  return {
    subject: '[' + brand.store_name + '] Wholesale balance low: ' + money(d.balance_cents, d.currency),
    html: brandShell(brand, inner),
    text: 'Wholesale balance low: ' + money(d.balance_cents, d.currency) + '. Top up: ' + adminUrl,
  };
}
