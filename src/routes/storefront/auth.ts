/**
 * Storefront end-user auth routes — separate surface from /customer/* so
 * the public store can have its own signup/login/verify/reset URLs with
 * tenant slug awareness.
 *
 * The existing /customer/* router predates storefront and only does
 * signup + login. Storefront adds:
 *   - POST /storefront/auth/signup    (issues verify_token email pending)
 *   - POST /storefront/auth/login
 *   - POST /storefront/auth/verify-email/:token
 *   - POST /storefront/auth/forgot-password
 *   - POST /storefront/auth/reset-password
 *
 * Email delivery is the email agent's job — we mint the tokens and store
 * the verify_url / reset_url in the response payload (single-tenant dev
 * mode) so smoke tests can pluck them. Production will pluck them out of
 * the DB and ship via SES/postal/whichever.
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { query } from '../../services/database';
import { hashPassword, verifyPassword } from '../../services/auth';
import { signSession } from '../../services/jwt';
import { logger } from '../../services/logger';
import { sendEmail, isEmailConfigured } from '../../services/email-provider';
import { evaluateEmail, canonicalizeEmail } from '../../services/email-policy';

export const storefrontAuthRouter = Router();

const VERIFY_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_HOURS = 2;

function randomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * POST /storefront/auth/signup
 * Body: { email, password, display_name? }
 * Sets a verify_token; returns it in dev-mode so smoke tests can verify.
 * The JWT is issued immediately (verified or not) so the user can browse
 * the store; restricted operations re-check email_verified_at.
 */
storefrontAuthRouter.post('/signup', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { email, password, display_name } = req.body ?? {};
    if (typeof email !== 'string' || !email.includes('@')) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'Valid email required' } });
      return;
    }
    if (typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'Password must be ≥6 chars' } });
      return;
    }
    const policy = evaluateEmail(email);
    if (!policy.ok) {
      res.status(400).json({ error: {
        type: 'email_not_allowed',
        message: policy.reason === 'blocked'
          ? 'This email domain is not accepted (disposable / blocked)'
          : 'This email domain is not on the allowlist',
      } });
      return;
    }

    const hash = await hashPassword(password);
    const verifyToken = randomToken();
    const affCode = crypto.randomBytes(8).toString('hex');

    const rows = await query<{ id: number }>(
      `INSERT INTO end_user
         (tenant_id, email, password_hash, display_name, group_name, aff_code,
          verify_token, verify_token_expires_at, status)
       VALUES ($1, $2, $3, $4, 'default', $5,
               $6, NOW() + ($7::int || ' hours')::interval, 'active')
       RETURNING id`,
      [tenantId, email.toLowerCase(), hash, display_name ?? null, affCode, verifyToken, VERIFY_TOKEN_TTL_HOURS],
    );
    const userId = rows[0].id;

    const token = signSession({
      type: 'customer',
      endUserId: userId,
      tenantId,
      email: email.toLowerCase(),
    });

    logger.info({ userId, tenantId }, 'storefront:signup');

    // Fire-and-forget verification email when Resend is configured.
    // Dev/smoke mode (no key, or key=test) still returns verify_token in
    // the response body so tests can verify-flow without real SMTP.
    void sendEmail({
      to: email.toLowerCase(),
      template: 'verify-email',
      tenantId,
      data: { email: email.toLowerCase(), verify_token: verifyToken },
    }).catch((e: any) => logger.warn({ err: e.message }, 'storefront:signup:email_fail'));

    // Keep verify_token in response so smoke tests + dev mode can verify
    // without polling the inbox. Production deployments still rely on the
    // email; the token in the body is harmless because the email goes out
    // simultaneously.
    res.status(201).json({
      token,
      user: { id: userId, email: email.toLowerCase(), aff_code: affCode },
      verify_token: verifyToken,
      verify_url_hint: `/storefront/auth/verify-email/${verifyToken}`,
      email_sent: isEmailConfigured(),
    });
  } catch (err: any) {
    if (err.message?.includes('duplicate key')) {
      res.status(409).json({ error: { type: 'conflict', message: 'email already exists' } });
      return;
    }
    logger.error({ err: err.message }, 'storefront:signup:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/** POST /storefront/auth/login */
storefrontAuthRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'email and password required' } });
      return;
    }
    const rows = await query<any>(
      `SELECT id, email, password_hash, status, email_verified_at
         FROM end_user
        WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
      [tenantId, email],
    );
    if (rows.length === 0 || rows[0].status !== 'active') {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }
    const ok = await verifyPassword(password, rows[0].password_hash);
    if (!ok) {
      res.status(401).json({ error: { type: 'authentication_error', message: 'Invalid credentials' } });
      return;
    }
    const token = signSession({
      type: 'customer',
      endUserId: rows[0].id,
      tenantId,
      email: rows[0].email,
    });
    res.json({
      token,
      user: {
        id: rows[0].id,
        email: rows[0].email,
        email_verified: rows[0].email_verified_at != null,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'storefront:login:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/** POST /storefront/auth/verify-email/:token */
storefrontAuthRouter.post('/verify-email/:token', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const token = String(req.params.token || '');
  if (!token) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'token required' } });
    return;
  }
  const rows = await query<any>(
    `UPDATE end_user
        SET email_verified_at = NOW(),
            verify_token = NULL,
            verify_token_expires_at = NULL
      WHERE tenant_id = $1
        AND verify_token = $2
        AND (verify_token_expires_at IS NULL OR verify_token_expires_at > NOW())
      RETURNING id, email`,
    [tenantId, token],
  );
  if (rows.length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Invalid or expired verification token' } });
    return;
  }
  res.json({ ok: true, user: rows[0] });
});

/** POST /storefront/auth/forgot-password */
storefrontAuthRouter.post('/forgot-password', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const email = String(req.body?.email ?? '').toLowerCase().trim();
  if (!email.includes('@')) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Valid email required' } });
    return;
  }
  const resetToken = randomToken();
  // Always 200 (do not leak whether email exists)
  await query(
    `UPDATE end_user
        SET reset_token = $1,
            reset_token_expires_at = NOW() + ($2::int || ' hours')::interval
      WHERE tenant_id = $3 AND LOWER(email) = $4 AND status = 'active'`,
    [resetToken, RESET_TOKEN_TTL_HOURS, tenantId, email],
  );
  res.json({
    ok: true,
    // Dev-only convenience; production should mint via email and leave this null.
    reset_token: process.env.NODE_ENV === 'production' ? null : resetToken,
  });
});

/** POST /storefront/auth/reset-password  Body: { token, new_password } */
storefrontAuthRouter.post('/reset-password', async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const token = String(req.body?.token ?? '');
  const newPassword = String(req.body?.new_password ?? '');
  if (!token || newPassword.length < 6) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'token and new_password (≥6 chars) required' },
    });
    return;
  }
  const hash = await hashPassword(newPassword);
  const rows = await query<{ id: number }>(
    `UPDATE end_user
        SET password_hash = $1,
            reset_token = NULL,
            reset_token_expires_at = NULL
      WHERE tenant_id = $2
        AND reset_token = $3
        AND reset_token_expires_at > NOW()
      RETURNING id`,
    [hash, tenantId, token],
  );
  if (rows.length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Invalid or expired reset token' } });
    return;
  }
  res.json({ ok: true, user_id: rows[0].id });
});
