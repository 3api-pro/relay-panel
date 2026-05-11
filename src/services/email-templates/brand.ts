/**
 * Brand-injection helper. Every template HTML body is wrapped with the
 * tenant brand_config (logo + name + primary_color) so the email looks
 * like it comes from the storefront, not from 3api itself.
 */
export interface Brand {
  store_name: string;
  logo_url: string | null;
  primary_color: string;
  footer_html: string | null;
  contact_email: string | null;
  public_base_url: string;
}

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function btn(href: string, label: string, color: string): string {
  return (
    '<a href="' + escapeHtml(href) + '" style="display:inline-block;background:' + color +
    ';color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">' +
    escapeHtml(label) + '</a>'
  );
}

export function brandShell(brand: Brand, innerHtml: string): string {
  const primary = brand.primary_color || '#6366f1';
  const logo = brand.logo_url
    ? '<img src="' + escapeHtml(brand.logo_url) + '" alt="' + escapeHtml(brand.store_name) +
      '" style="height:36px;display:block;margin:0 auto 8px;">'
    : '';
  const footer = brand.footer_html
    ? '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;color:#888;font-size:12px;text-align:center;">' +
      brand.footer_html + '</div>'
    : '';
  const contact = brand.contact_email
    ? '<div style="text-align:center;color:#888;font-size:12px;margin-top:8px;">Contact: <a href="mailto:' +
      escapeHtml(brand.contact_email) + '" style="color:' + primary + ';">' +
      escapeHtml(brand.contact_email) + '</a></div>'
    : '';

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>' + escapeHtml(brand.store_name) + '</title></head>',
    '<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">',
    '<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">',
    '  <div style="background:' + primary + ';padding:24px 24px 20px;text-align:center;">',
    '    ' + logo,
    '    <div style="color:#fff;font-size:18px;font-weight:600;">' + escapeHtml(brand.store_name) + '</div>',
    '  </div>',
    '  <div style="padding:28px 24px;line-height:1.55;font-size:15px;">',
    '    ' + innerHtml,
    '  </div>',
    '  ' + footer,
    '  ' + contact,
    '</div>',
    '</body></html>',
  ].join('\n');
}
