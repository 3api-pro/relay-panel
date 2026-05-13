/**
 * Email transport facade. Picks a provider chain based on app_config
 * `email_provider` (∈ ses | resend | both | log; default 'log'):
 *   ses     →  SES only; on fail log_only.
 *   resend  →  Resend only; on fail log_only.
 *   both    →  Try SES first; on fail try Resend; on fail log_only.
 *   log     →  Never sends; logs intent. (default)
 *
 * Same SendEmailInput / template surface as the previous email-resend.ts
 * so call sites don't need to change beyond the import path.
 *
 * Per-recipient cooldown is enforced HERE (default 60s) so any caller
 * gets it for free. Override with `bypassCooldown: true` for hard cases
 * (system notifications) — never for verification emails.
 */
import { config } from '../config';
import { getConfig } from './app-config';
import { query } from './database';
import { logger } from './logger';
import { logEmailSent, recentlySentTo } from './email-policy';
import { sendViaSes, isSesConfigured } from './email-aws-ses';

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
  /** When true, skip the recent-send cooldown. Default false. */
  bypassCooldown?: boolean;
}

const DEFAULT_COOLDOWN_SECONDS = 60;

async function loadBrand(tenantId: number): Promise<Brand> {
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

function renderTemplate(
  template: EmailTemplate,
  brand: Brand,
  data: any,
): { subject: string; html: string; text: string } {
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
      const _ex: never = template;
      throw new Error(`Unknown template: ${_ex}`);
    }
  }
}

export function isEmailConfigured(): boolean {
  if (isSesConfigured()) return true;
  if (config.resendApiKey && config.resendApiKey !== 'test') return true;
  return false;
}

// ---- Resend transport (legacy provider, kept inline) ---------------------
async function sendViaResend(
  to: string,
  subject: string,
  html: string,
  text: string,
  fromOverride?: string,
): Promise<{ ok: boolean; providerMessageId?: string; error?: string }> {
  const key = config.resendApiKey;
  if (!key) return { ok: false, error: 'resend_not_configured' };
  if (key === 'test') {
    logger.info({ to, subject }, 'email:resend:test_mode');
    return { ok: true, providerMessageId: 'test' };
  }
  const from = fromOverride || config.emailDefaultFrom;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, error: `resend_${r.status}: ${body.slice(0, 200)}` };
    }
    const parsed = (await r.json().catch(() => ({}))) as any;
    return { ok: true, providerMessageId: parsed?.id };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// --------------------------------------------------------------------------

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const provider = (getConfig('email_provider', 'log') || 'log').toLowerCase();
  const to = input.to.toLowerCase();

  if (!input.bypassCooldown) {
    const cooldown = parseInt(getConfig('email_cooldown_seconds', String(DEFAULT_COOLDOWN_SECONDS)), 10) || DEFAULT_COOLDOWN_SECONDS;
    if (await recentlySentTo(to, cooldown)) {
      logger.info({ to, template: input.template, cooldown }, 'email:skipped:cooldown');
      await logEmailSent(to, input.template, 'skipped', null, input.tenantId, 'cooldown');
      return false;
    }
  }

  const brand = await loadBrand(input.tenantId);
  const { subject, html, text } = renderTemplate(input.template, brand, input.data);

  if (provider === 'log') {
    logger.info({ to, template: input.template, subject }, 'email:log_only');
    await logEmailSent(to, input.template, 'sent', 'log', input.tenantId, null);
    return true;
  }

  // Order: ses → resend → log (depending on selected mode).
  const tryOrder: ('ses' | 'resend')[] =
    provider === 'ses' ? ['ses'] :
    provider === 'resend' ? ['resend'] :
    provider === 'both' ? ['ses', 'resend'] :
    ['ses', 'resend'];

  let lastErr = 'no_provider';
  for (const p of tryOrder) {
    if (p === 'ses') {
      const r = await sendViaSes({ to, subject, html, text });
      if (r.ok) {
        logger.info({ to, template: input.template, provider: 'ses', id: r.providerMessageId }, 'email:sent');
        await logEmailSent(to, input.template, 'sent', 'ses', input.tenantId, null);
        return true;
      }
      lastErr = r.error || 'ses_failed';
      logger.warn({ to, err: lastErr }, 'email:ses:fail_will_fallback');
    } else if (p === 'resend') {
      const r = await sendViaResend(to, subject, html, text);
      if (r.ok) {
        logger.info({ to, template: input.template, provider: 'resend', id: r.providerMessageId }, 'email:sent');
        await logEmailSent(to, input.template, 'sent', 'resend', input.tenantId, null);
        return true;
      }
      lastErr = r.error || 'resend_failed';
      logger.warn({ to, err: lastErr }, 'email:resend:fail');
    }
  }

  logger.error({ to, template: input.template, err: lastErr }, 'email:all_providers_failed');
  await logEmailSent(to, input.template, 'failed', null, input.tenantId, lastErr.slice(0, 200));
  return false;
}
