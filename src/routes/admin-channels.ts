/**
 * Admin upstream-channel management.
 *
 * A "channel" is one upstream that the panel can forward /v1/messages to.
 * Tenants can configure many; one is marked default and used by relay.
 *
 * Mount under the existing adminRouter so all routes inherit
 * tenantResolver + authAdmin from the parent.
 */
import { Router, Request, Response } from 'express';
import { query, withTransaction } from '../services/database';
import { logger } from '../services/logger';

export const channelsRouter = Router();

const VALID_TYPES = new Set([
  'wholesale-3api',
  'byok-claude',
  'byok-openai-compat',
  'byok-other',
]);

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ChannelInput {
  name?: string;
  base_url?: string;
  api_key?: string;
  type?: string;
  status?: string;
  weight?: number;
  priority?: number;
  models?: string;
  group_access?: string;
}

function validate(body: ChannelInput, partial = false): string | null {
  const required = (k: keyof ChannelInput): string | null =>
    partial ? null : body[k] == null ? `${k} required` : null;
  return (
    required('name') ||
    required('base_url') ||
    required('api_key') ||
    (body.name != null && (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 64)
      ? 'name must be 1-64 chars' : null) ||
    (body.base_url != null && (typeof body.base_url !== 'string' || !isValidUrl(body.base_url))
      ? 'base_url must be a valid http(s) URL' : null) ||
    (body.api_key != null && (typeof body.api_key !== 'string' || body.api_key.length < 8)
      ? 'api_key must be ≥8 chars' : null) ||
    (body.type != null && !VALID_TYPES.has(body.type)
      ? `type must be one of: ${Array.from(VALID_TYPES).join(', ')}` : null) ||
    (body.status != null && !['active', 'disabled'].includes(body.status)
      ? "status must be 'active' or 'disabled'" : null)
  );
}

const SAFE_COLS = `id, tenant_id, name, base_url, type, status, weight, priority, is_default, models, group_access, created_at`;

/**
 * POST /admin/channels
 * Body: { name, base_url, api_key, type?, models?, group_access?, weight?, priority? }
 * Returns the created row WITHOUT api_key.
 */
channelsRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const body: ChannelInput = req.body ?? {};
  const v = validate(body);
  if (v) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: v } });
    return;
  }

  const rows = await query<any>(
    `INSERT INTO upstream_channel
       (tenant_id, name, base_url, api_key, type, status, weight, priority, models, group_access)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
     RETURNING ${SAFE_COLS}`,
    [
      tenantId,
      body.name,
      body.base_url,
      body.api_key,
      body.type ?? 'byok-claude',
      Number(body.weight ?? 100),
      Number(body.priority ?? 100),
      body.models ?? null,
      body.group_access ?? 'default',
    ],
  );
  res.status(201).json(rows[0]);
});

/**
 * GET /admin/channels
 * Returns the channel list WITHOUT api_key (only key_preview = first 6 chars + ...).
 */
channelsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const rows = await query<any>(
    `SELECT ${SAFE_COLS},
            CASE
              WHEN length(api_key) > 12 THEN substr(api_key, 1, 6) || '…' || substr(api_key, -4)
              WHEN length(api_key) > 0  THEN '…'
              ELSE NULL
            END AS key_preview
       FROM upstream_channel
      WHERE tenant_id = $1
      ORDER BY is_default DESC, weight DESC, id ASC`,
    [tenantId],
  );
  res.json({ data: rows });
});

/**
 * PATCH /admin/channels/:id
 * Partial update; only provided fields are touched.
 */
channelsRouter.patch('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const body: ChannelInput = req.body ?? {};
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
  if (body.name        != null) push('name', body.name);
  if (body.base_url    != null) push('base_url', body.base_url);
  if (body.api_key     != null) push('api_key', body.api_key);
  if (body.type        != null) push('type', body.type);
  if (body.status      != null) push('status', body.status);
  if (body.weight      != null) push('weight', Number(body.weight));
  if (body.priority    != null) push('priority', Number(body.priority));
  if (body.models      != null) push('models', body.models);
  if (body.group_access!= null) push('group_access', body.group_access);

  if (sets.length === 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'no fields to update' } });
    return;
  }
  vals.push(id, tenantId);
  const rows = await query<any>(
    `UPDATE upstream_channel SET ${sets.join(', ')}
       WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length}
     RETURNING ${SAFE_COLS}`,
    vals,
  );
  if (rows.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
    return;
  }
  res.json(rows[0]);
});

/**
 * POST /admin/channels/:id/set-default
 * Atomically clears any other default in the same tenant and marks this one.
 */
channelsRouter.post('/:id/set-default', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }

  try {
    const row = await withTransaction(async (client) => {
      const exists = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM upstream_channel WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (exists.rows.length === 0) return null;
      if (exists.rows[0].status !== 'active') {
        throw Object.assign(new Error('cannot set a disabled channel as default'), { http: 400 });
      }
      await client.query(
        `UPDATE upstream_channel SET is_default = FALSE WHERE tenant_id = $1 AND id <> $2`,
        [tenantId, id],
      );
      const r = await client.query<any>(
        `UPDATE upstream_channel SET is_default = TRUE WHERE id = $1 AND tenant_id = $2
         RETURNING ${SAFE_COLS}`,
        [id, tenantId],
      );
      return r.rows[0];
    });
    if (!row) {
      res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
      return;
    }
    logger.info({ tenantId, channelId: id }, 'admin:channel:set_default');
    res.json(row);
  } catch (err: any) {
    if (err?.http === 400) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: err.message } });
      return;
    }
    logger.error({ err: err?.message ?? String(err) }, 'admin:channel:set_default:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

/**
 * DELETE /admin/channels/:id
 * Hard delete. If you'd rather disable, use PATCH with status:'disabled'.
 * Cannot delete an is_default channel — clear default first.
 */
channelsRouter.delete('/:id', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const cur = await query<{ is_default: boolean }>(
    `SELECT is_default FROM upstream_channel WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (cur.length === 0) {
    res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
    return;
  }
  if (cur[0].is_default) {
    res.status(400).json({
      error: { type: 'invalid_request_error', message: 'cannot delete the default channel — set another channel as default first' },
    });
    return;
  }
  await query(`DELETE FROM upstream_channel WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  res.status(204).end();
});
