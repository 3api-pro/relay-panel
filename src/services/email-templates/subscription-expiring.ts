import { Brand, brandShell, escapeHtml, btn } from './brand';

export interface SubscriptionExpiringData {
  plan_name: string;
  expires_at: string;
  days_left: number;
}

export function renderSubscriptionExpiring(brand: Brand, d: SubscriptionExpiringData): { subject: string; html: string; text: string } {
  const renewUrl = brand.public_base_url.replace(/\/+$/, '') + '/pricing';
  const inner = [
    '<h2 style="margin-top:0;">Your plan expires in ' + d.days_left + ' day' + (d.days_left === 1 ? '' : 's') + '</h2>',
    '<p>Your <b>' + escapeHtml(d.plan_name) + '</b> plan ends on <b>' + escapeHtml(new Date(d.expires_at).toUTCString()) + '</b>.</p>',
    '<p>Renew now to keep your API key active and avoid service interruption.</p>',
    '<p style="text-align:center;margin:24px 0;">' + btn(renewUrl, 'Renew plan', brand.primary_color) + '</p>',
    '<p style="color:#888;font-size:12px;">If you have already renewed, you can ignore this notice.</p>',
  ].join('\n');
  return {
    subject: '[' + brand.store_name + '] ' + escapeHtml(d.plan_name) + ' expires in ' + d.days_left + ' day' + (d.days_left === 1 ? '' : 's'),
    html: brandShell(brand, inner),
    text: 'Your plan ' + d.plan_name + ' expires in ' + d.days_left + ' days (' + d.expires_at + '). Renew: ' + renewUrl,
  };
}
