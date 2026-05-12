/**
 * Iframe-friendly storefront widget served from the SaaS root domain.
 *
 *   GET /embed/:slug
 *
 * Renders a self-contained mini "buy box" — tenant logo, 1-3 plan cards,
 * brand-coloured "Buy now" CTA targeting `_top` so the user is taken to
 * the real storefront (`<slug>.<saasDomain>/checkout?plan=<id>`) rather
 * than navigating inside the embed.
 *
 * Why SSR HTML and not a Next.js page:
 *   - Static export means we'd hydrate React + Tailwind to render 3
 *     cards, which is overkill for a 1 KB widget many bloggers iframe
 *     above the fold.
 *   - SSR also lets us drop `X-Frame-Options` so embedding actually
 *     works (Next defaults via middleware would deny same-origin only).
 */
import { Router, Request, Response } from 'express';
import { query } from '../services/database';
import { config } from '../config';
import { logger } from '../services/logger';

export const embedRouter = Router();

interface Tenant { id: number; slug: string; status: string; custom_domain: string | null }
interface Brand { store_name: string | null; logo_url: string | null; primary_color: string | null; announcement: string | null }
interface Plan {
  id: number;
  name: string;
  slug: string;
  period_days: number;
  quota_tokens: number;
  price_cents: number;
  billing_type: string | null;
}

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;'
  ));
}

function fmtPriceCNY(cents: number): string {
  const yuan = (cents || 0) / 100;
  return `¥${yuan.toFixed(yuan < 10 ? 2 : 0)}`;
}

function fmtPeriod(days: number): string {
  if (days >= 365) return `${Math.round(days / 365)} 年`;
  if (days >= 28) return `${Math.round(days / 30)} 月`;
  if (days >= 7) return `${Math.round(days / 7)} 周`;
  return `${days} 天`;
}

embedRouter.get('/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').toLowerCase().trim();
  if (!/^[a-z0-9-]{1,32}$/.test(slug)) {
    res.status(400).type('html').send('<!doctype html><meta charset=utf-8><title>3API embed</title><p style="font-family:sans-serif;padding:24px;color:#475569">Invalid slug.</p>');
    return;
  }

  let tenant: Tenant | undefined;
  let brand: Brand;
  let plans: Plan[];
  try {
    const tRows = await query<Tenant>(
      `SELECT id, slug, status, custom_domain FROM tenant WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    tenant = tRows[0];
    if (!tenant || tenant.status !== 'active') {
      res.status(404).type('html').send('<!doctype html><meta charset=utf-8><title>3API embed</title><p style="font-family:sans-serif;padding:24px;color:#475569">店铺不存在或已停用。</p>');
      return;
    }
    const [brandRows, planRows] = await Promise.all([
      query<Brand>(
        `SELECT store_name, logo_url, primary_color, announcement
           FROM brand_config WHERE tenant_id = $1 LIMIT 1`,
        [tenant.id],
      ),
      query<Plan>(
        `SELECT id, name, slug, period_days, quota_tokens, price_cents, billing_type
           FROM plans
          WHERE tenant_id = $1 AND enabled = TRUE
          ORDER BY sort_order ASC, id ASC
          LIMIT 3`,
        [tenant.id],
      ),
    ]);
    brand = brandRows[0] || { store_name: null, logo_url: null, primary_color: null, announcement: null };
    plans = planRows;
  } catch (err: any) {
    logger.error({ err: err.message, slug }, 'embed:db_error');
    res.status(500).type('html').send('<!doctype html><meta charset=utf-8><title>3API embed</title><p style="font-family:sans-serif;padding:24px;color:#475569">Internal error.</p>');
    return;
  }

  const primary = brand.primary_color || '#0d9488';
  const storeName = brand.store_name || tenant.slug;
  const storefrontHost = tenant.custom_domain
    ? tenant.custom_domain
    : (config.saasDomain ? `${tenant.slug}.${config.saasDomain}` : `${tenant.slug}.3api.pro`);
  const checkoutBase = `https://${storefrontHost}/checkout`;

  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(storeName)} — 3API 套餐</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; background: transparent; color: #0f172a; -webkit-font-smoothing: antialiased; line-height: 1.4; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 16px; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .head img { width: 32px; height: 32px; border-radius: 6px; object-fit: cover; }
  .head .name { font-weight: 600; font-size: 16px; }
  .ann { background: ${esc(primary)}10; color: ${esc(primary)}; border-left: 3px solid ${esc(primary)}; padding: 8px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
  @media (min-width: 540px) { .grid { grid-template-columns: repeat(${Math.min(plans.length, 3)}, 1fr); } }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; }
  .card h3 { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .card .price { font-size: 22px; font-weight: 700; color: ${esc(primary)}; }
  .card .price small { font-size: 12px; font-weight: 500; color: #475569; }
  .card .meta { font-size: 12px; color: #475569; margin: 6px 0 12px; }
  .card .cta { background: ${esc(primary)}; color: #fff; text-align: center; padding: 9px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; text-decoration: none; display: block; }
  .card .cta:hover { opacity: 0.9; }
  .empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0; }
  .footer { margin-top: 14px; text-align: right; font-size: 11px; color: #94a3b8; }
  .footer a { color: ${esc(primary)}; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    html, body { color: #e2e8f0; }
    .card { background: #1e293b; border-color: #334155; }
    .card .meta { color: #94a3b8; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    ${brand.logo_url ? `<img src="${esc(brand.logo_url)}" alt="">` : ''}
    <div class="name">${esc(storeName)}</div>
  </div>
  ${brand.announcement ? `<div class="ann">${esc(brand.announcement)}</div>` : ''}
  ${plans.length === 0
    ? '<div class="empty">还未配置套餐</div>'
    : `<div class="grid">${plans.map((p) => `
      <div class="card">
        <h3>${esc(p.name)}</h3>
        <div class="price">${fmtPriceCNY(p.price_cents)}<small> / ${fmtPeriod(p.period_days)}</small></div>
        <div class="meta">${(p.quota_tokens / 1_000_000).toFixed(1)}M tokens · ${esc(p.billing_type || 'subscription')}</div>
        <a class="cta" href="${esc(checkoutBase)}?plan=${p.id}&utm_source=embed" target="_top">立即购买 →</a>
      </div>`).join('')}</div>`}
  <div class="footer">Powered by <a href="https://3api.pro" target="_top">3API</a></div>
</div>
</body></html>`;

  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').status(200).send(html);
});
