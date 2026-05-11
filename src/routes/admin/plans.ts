/**
 * Admin Plans CRUD — managed by the tenant's reseller admin.
 *
 * Mounted under adminRouter so all routes inherit tenantResolver + authAdmin.
 * Soft delete via enabled=false; hard delete blocked when orders reference
 * the plan.
 */
import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../../services/database';
import { logger } from '../../services/logger';

export const adminPlansRouter = Router();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

interface PlanInput {
  name?: string;
  slug?: string;
  period_days?: number;
  quota_tokens?: number;
  price_cents?: number;
  wholesale_face_value_cents?: number;
  allowed_models?: string[] | string;
  enabled?: boolean;
  sort_order?: number;
}

function validate(body: PlanInput, partial = false): string | null {
  const req = (k: keyof PlanInput): string | null =>
    partial ? null : body[k] == null ? `${k} required` : null;

  return (
    req('name') ||
    req('slug') ||
    req('period_days') ||
    req('quota_tokens') ||
    req('price_cents') ||
    req('wholesale_face_value_cents') ||
    (body.name != null && (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 64)
      ? 'name must be 1-64 chars'
      : null) ||
    (body.slug != null && (typeof body.slug !== 'string' || !SLUG_RE.test(body.slug))
      ? 'slug must match [a-z0-9-], 1-32 chars'
      : null) ||
    (body.period_days != null && (!Number.isInteger(body.period_days) || body.period_days < 1)
      ? 'period_days must be a positive integer'
      : null) ||
    (body.quota_tokens != null && (typeof body.quota_tokens !== 'number' || body.quota_tokens < -1)
      ? 'quota_tokens must be ≥ -1 (-1 = unlimited)'
      : null) ||
    (body.price_cents != null && (!Number.isInteger(body.price_cents) || body.price_cents < 0)
      ? 'price_cents must be a non-negative integer'
      : null) ||
    (body.wholesale_face_value_cents != null &&
    (!Number.isInteger(body.wholesale_face_value_cents) || body.wholesale_face_value_cents < 0)
      ? 'wholesale_face_value_cents must be a non-negative integer'
      : null)
  );
}

function normalizeAllowedModels(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
    } catch { /* fall through */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** GET /admin/plans */
adminPlansRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const rows = await query<any>(
    `SELECT id, name, slug, period_days, quota_tokens, price_cents,
            wholesale_face_value_cents, allowed_models, enabled, sort_order, created_at
       FROM plans
      WHERE tenant_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [tenantId],
  );
  res.json({ data: rows });
});

/** POST /admin/plans */
adminPlansRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body: PlanInput = req.body ?? {};
  const v = validate(body);
  if (v) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: v } });
    return;
  }
  const allowedModels = body.allowed_models == null ? [] : normalizeAllowedModels(body.allowed_models);

  try {
    const rows = await query<any>(
      `INSERT INTO plans
         (tenant_id, name, slug, period_days, quota_tokens, price_cents,
          wholesale_face_value_cents, allowed_models, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id, name, slug, period_days, quota_tokens, price_cents,
                 wholesale_face_value_cents, allowed_models, enabled, sort_order, created_at`,
      [
        tenantId,
        body.name,
        body.slug,
        body.period_days,
        body.quota_tokens,
        body.price_cents,
        body.wholesale_face_value_cents,
        JSON.stringify(allowedModels),
        body.enabled != null ? !!body.enabled : true,
        Number(body.sort_order ?? 0),
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: { type: 'conflict', message: 'plan slug already exists for this tenant' } });
      return;
    }
    logger.error({ err: err.message }, 'admin:plans:create:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/** PATCH /admin/plans/:id */
adminPlansRouter.patch('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const body: PlanInput = req.body ?? {};
  const v = validate(body, true);
  if (v) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: v } });
    return;
  }

  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, val: any): void => {
    sets.push(`${col} = $${sets.length + 1}`);
    vals.push(val);
  };
  if (body.name != null) push('name', body.name);
  if (body.slug != null) push('slug', body.slug);
  if (body.period_days != null) push('period_days', body.period_days);
  if (body.quota_tokens != null) push('quota_tokens', body.quota_tokens);
  if (body.price_cents != null) push('price_cents', body.price_cents);
  if (body.wholesale_face_value_cents != null) push('wholesale_face_value_cents', body.wholesale_face_value_cents);
  if (body.allowed_models != null) push('allowed_models', JSON.stringify(normalizeAllowedModels(body.allowed_models)));
  if (body.enabled != null) push('enabled', !!body.enabled);
  if (body.sort_order != null) push('sort_order', Number(body.sort_order));

  if (sets.length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'no fields to update' } });
    return;
  }
  // The allowed_models set needs ::jsonb cast — patch the SQL after string build.
  let setSql = sets.join(', ');
  setSql = setSql.replace(/allowed_models = (\$\d+)/g, 'allowed_models = $1::jsonb');

  vals.push(id, tenantId);
  try {
    const rows = await query<any>(
      `UPDATE plans SET ${setSql}
         WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length}
         RETURNING id, name, slug, period_days, quota_tokens, price_cents,
                   wholesale_face_value_cents, allowed_models, enabled, sort_order, created_at`,
      vals,
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'plan not found' } });
      return;
    }
    res.json(rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: { type: 'conflict', message: 'plan slug collision' } });
      return;
    }
    logger.error({ err: err.message }, 'admin:plans:patch:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * DELETE /admin/plans/:id
 * Soft delete (enabled=false) when orders reference the plan; hard delete
 * only when no order has ever used it.
 */
adminPlansRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }

  const orderRefs = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orders WHERE plan_id = $1`,
    [id],
  );
  const hasOrders = Number(orderRefs[0]?.count ?? '0') > 0;

  if (hasOrders) {
    const rows = await query<any>(
      `UPDATE plans SET enabled = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING id, enabled`,
      [id, tenantId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'plan not found' } });
      return;
    }
    res.json({ id: rows[0].id, soft_deleted: true });
    return;
  }

  const r = await query<{ id: number }>(
    `DELETE FROM plans WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId],
  );
  if (r.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'plan not found' } });
    return;
  }
  res.status(204).end();
});

/** POST /admin/plans/reorder  Body: { order: [planId, planId, ...] } */
adminPlansRouter.post('/reorder', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const order = req.body?.order;
  if (!Array.isArray(order) || order.some((x) => !Number.isInteger(x))) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'order: number[] required' } });
    return;
  }

  await withTransaction(async (client) => {
    for (let i = 0; i < order.length; i++) {
      await client.query(
        `UPDATE plans SET sort_order = $1 WHERE id = $2 AND tenant_id = $3`,
        [(i + 1) * 10, order[i], tenantId],
      );
    }
  });
  res.json({ ok: true, count: order.length });
});
