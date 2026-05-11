/**
 * Email delivery via Resend (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Why Resend: 100 free emails/day, simple POST API, no SMTP machinery.
 * We POST directly to https://api.resend.com/emails so we do not need the
 * resend npm package (which is not in node_modules anyway).
 *
 * Templates: src/services/email-templates/<kind>.ts each export a render*()
 * that returns { subject, html, text } given brand + data.
 *
 * Brand injection: per-tenant brand_config (logo, name, primary_color,
 * footer_html, contact_email) is pulled once and threaded into every send.
 *
 * Behavior:
 *   - RESEND_API_KEY unset  → log-only (dev mode); never throws.
 *   - RESEND_API_KEY=test   → log-only with templated subject/html (used by
 *                             smoke tests; counts towards send-success).
 *   - real key              → POST to api.resend.com.
 *
 * The function is best-effort: failures log + return false, never throw.
 */
import { config } from '../config';
import { query } from './database';
import { logger } from './logger';

import { Brand } from './email-templates/brand';
import { renderVerifyEmail, VerifyEmailData } from './email-templates/verify-email';
import { renderOrderSuccess, OrderSuccessData } from './email-templates/order-success';
import {
  renderSubscriptionExpiring,
  SubscriptionExpiringData,
} from './email-templates/subscription-expiring';
import {
  renderRefundConfirmation,
  RefundConfirmationData,
} from './email-templates/refund-confirmation';
import { renderWholesaleLow, WholesaleLowData } from './email-templates/wholesale-low';

export type EmailTemplate =
  | 'verify-email'
  | 'order-success'
  | 'subscription-expiring'
  | 'refund-confirmation'
  | 'wholesale-low';

export interface SendEmailInput {
  to: string;
  template: EmailTemplate;
  data: any;
  tenantId: number;
}

const TEST_KEY = 'test';

export async function loadBrand(tenantId: number): Promise<Brand> {
  const rows = await query<any>(
    'SELECT store_name, logo_url, primary_color, footer_html, contact_email FROM brand_config WHERE tenant_id = $1 LIMIT 1',
    [tenantId],
  );
  const b = rows[0] ?? {};
  return {
    store_name: b.store_name || '3API Storefront',
    logo_url: b.logo_url || null,
    primary_color: b.primary_color || '#6366f1',
    footer_html: b.footer_html || null,
    contact_email: b.contact_email || null,
    public_base_url: config.publicBaseUrl,
  };
}

async function tenantEmailFrom(tenantId: number, brand: Brand): Promise<string> {
  const rows = await query<any>(
    "SELECT (config->'email_config'->>'email_from') AS email_from, slug FROM tenant WHERE id = $1 LIMIT 1",
    [tenantId],
  );
  const row = rows[0] ?? {};
  if (row.email_from) return row.email_from;
  if (config.emailDefaultFrom) return brand.store_name + ' <' + config.emailDefaultFrom + '>';
  return 'noreply@3api.pro';
}

function renderByKind(brand: Brand, template: EmailTemplate, data: any) {
  switch (template) {
    case 'verify-email':
      return renderVerifyEmail(brand, data as VerifyEmailData);
    case 'order-success':
      return renderOrderSuccess(brand, data as OrderSuccessData);
    case 'subscription-expiring':
      return renderSubscriptionExpiring(brand, data as SubscriptionExpiringData);
    case 'refund-confirmation':
      return renderRefundConfirmation(brand, data as RefundConfirmationData);
    case 'wholesale-low':
      return renderWholesaleLow(brand, data as WholesaleLowData);
    default: {
      const exhaustive: never = template;
      throw new Error('unknown_template:' + exhaustive);
    }
  }
}

export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean; mode: string; id?: string; error?: string }> {
  const brand = await loadBrand(input.tenantId);
  const rendered = renderByKind(brand, input.template, input.data);
  const from = await tenantEmailFrom(input.tenantId, brand);
  // Read env *now* so that smoke tests which late-set RESEND_API_KEY still pick it up.
  const key = process.env.RESEND_API_KEY || config.resendApiKey;

  if (!key) {
    logger.info(
      { to: input.to, template: input.template, subject: rendered.subject, mode: 'log-only' },
      'email:render:no-key',
    );
    return { ok: true, mode: 'log-only' };
  }

  if (key === TEST_KEY) {
    logger.info(
      {
        to: input.to,
        template: input.template,
        subject: rendered.subject,
        from,
        htmlBytes: rendered.html.length,
        mode: 'test',
      },
      'email:render:test-mode',
    );
    return { ok: true, mode: 'test', id: 'test-' + Date.now() };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    const j: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      logger.warn({ to: input.to, template: input.template, status: resp.status, body: j }, 'email:send:fail');
      return { ok: false, mode: 'resend', error: (j && j.message) || ('http_' + resp.status) };
    }
    logger.info({ to: input.to, template: input.template, id: j.id, mode: 'resend' }, 'email:sent');
    return { ok: true, mode: 'resend', id: j.id };
  } catch (err: any) {
    logger.error({ to: input.to, template: input.template, err: err.message }, 'email:send:error');
    return { ok: false, mode: 'resend', error: err.message };
  }
}

export function isEmailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || config.resendApiKey);
}
