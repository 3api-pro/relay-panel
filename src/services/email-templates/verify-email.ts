import { Brand, brandShell, escapeHtml, btn } from './brand';

export interface VerifyEmailData {
  email: string;
  verify_token: string;
}

export function renderVerifyEmail(brand: Brand, data: VerifyEmailData): { subject: string; html: string; text: string } {
  const url = brand.public_base_url.replace(/\/+$/, '') + '/storefront/auth/verify-email/' + encodeURIComponent(data.verify_token);
  const inner = [
    '<h2 style="margin-top:0;">Verify your email</h2>',
    '<p>Hi,</p>',
    '<p>Thanks for signing up at <b>' + escapeHtml(brand.store_name) + '</b>. Please click the button below to verify your email <b>' + escapeHtml(data.email) + '</b>.</p>',
    '<p style="text-align:center;margin:28px 0;">' + btn(url, 'Verify email', brand.primary_color) + '</p>',
    '<p style="color:#888;font-size:12px;">Or copy this link: <br><a href="' + escapeHtml(url) + '">' + escapeHtml(url) + '</a></p>',
    '<p style="color:#888;font-size:12px;">This link expires in 24 hours. If you did not sign up, ignore this email.</p>',
  ].join('\n');
  return {
    subject: '[' + brand.store_name + '] Verify your email',
    html: brandShell(brand, inner),
    text: 'Verify your email at ' + brand.store_name + ': ' + url,
  };
}
