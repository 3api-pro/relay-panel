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
import {
  addKey,
  removeKey,
  replaceKeys,
  maskKey,
  ChannelKeyEntry,
} from '../services/channel-keys';
import { testChannel } from '../services/channel-test';

export const channelsRouter = Router();

// Legacy taxonomy kept for backward compat — the UI / signup-tenant /
// onboarding all set one of these on creation. v0.3 introduces a separate
// `provider_type` for the protocol adapter.
const VALID_TYPES = new Set([
  'wholesale-3api',
  'byok-claude',
  'byok-openai-compat',
  'byok-other',
]);

// v0.3 — protocol adapter selector. Mirror of the DB CHECK constraint
// in migration 010. Validated on POST/PATCH to keep bad enum values out.
const VALID_PROVIDER_TYPES = new Set([
  'anthropic',
  'openai',
  'gemini',
  'moonshot',
  'deepseek',
  'minimax',
  'qwen',
  'llmapi-wholesale',
  'custom',
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
  // v0.3 — new-api parity fields.
  provider_type?: string;
  model_mapping?: Record<string, string> | null;
  custom_headers?: Record<string, string> | null;
  enabled?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringStringMap(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || typeof val !== 'string') return false;
  }
  return true;
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
      ? "status must be 'active' or 'disabled'" : null) ||
    (body.provider_type != null && !VALID_PROVIDER_TYPES.has(body.provider_type)
      ? `provider_type must be one of: ${Array.from(VALID_PROVIDER_TYPES).join(', ')}` : null) ||
    (body.model_mapping != null && !isStringStringMap(body.model_mapping)
      ? 'model_mapping must be a {string: string} object' : null) ||
    (body.custom_headers != null && !isStringStringMap(body.custom_headers)
      ? 'custom_headers must be a {string: string} object' : null) ||
    (body.enabled != null && typeof body.enabled !== 'boolean'
      ? 'enabled must be a boolean' : null)
  );
}

const SAFE_COLS = `id, tenant_id, name, base_url, type, status, weight, priority, is_default,
                   models, model_mapping, custom_headers, group_access, created_at,
                   provider_type, enabled, is_recommended, last_tested_at, last_test_result`;

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

  // New rows: seed keys[0] = api_key so the multi-key picker has at least
  // one entry. Admin can later add more via POST /:id/keys.
  const seedKeys = JSON.stringify([
    {
      key: body.api_key,
      status: 'active',
      added_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      cooled_until: null,
      last_error: null,
    },
  ]);

  // v0.3 — default provider_type from legacy `type` if caller didn't pin one.
  // wholesale-3api → llmapi-wholesale; everything else → anthropic. This
  // matches the migration-010 backfill rule so new and old rows agree.
  const inferredProvider =
    body.provider_type ??
    (body.type === 'wholesale-3api' ? 'llmapi-wholesale' : 'anthropic');

  const rows = await query<any>(
    `INSERT INTO upstream_channel
       (tenant_id, name, base_url, api_key, type, status, weight, priority,
        models, model_mapping, custom_headers, group_access, keys, current_key_idx,
        provider_type, enabled)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9::jsonb, $10::jsonb,
             $11, $12::jsonb, 0, $13, $14)
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
      body.model_mapping ? JSON.stringify(body.model_mapping) : '{}',
      body.custom_headers ? JSON.stringify(body.custom_headers) : '{}',
      body.group_access ?? 'default',
      seedKeys,
      inferredProvider,
      body.enabled !== false,
    ],
  );
  res.status(201).json(rows[0]);
});

/**
 * GET /admin/channels
 * Returns the channel list WITHOUT api_key. Each row also includes:
 *   - key_preview:  masked preview of the legacy api_key column
 *   - keys:         masked array — { preview, status, added_at, cooled_until, last_error }
 *   - keys_total / keys_active counts for quick UI display.
 */
channelsRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  // v0.3 — surface recommended channels at the top so the Hero card has
  // something to render in O(1) without re-querying.
  const rows = await query<any>(
    `SELECT ${SAFE_COLS},
            CASE
              WHEN length(api_key) > 12 THEN substr(api_key, 1, 6) || '…' || substr(api_key, -4)
              WHEN length(api_key) > 0  THEN '…'
              ELSE NULL
            END AS key_preview,
            COALESCE(keys, '[]'::jsonb) AS keys,
            current_key_idx
       FROM upstream_channel
      WHERE tenant_id = $1
      ORDER BY is_recommended DESC, is_default DESC, weight DESC, id ASC`,
    [tenantId],
  );
  const data = rows.map((r) => {
    const arr: ChannelKeyEntry[] = Array.isArray(r.keys) ? r.keys : [];
    const masked = arr.map((e) => ({
      preview: maskKey(e.key || ''),
      status: e.status || 'active',
      added_at: e.added_at || null,
      cooled_until: e.cooled_until || null,
      last_error: e.last_error || null,
    }));
    const keys_active = arr.filter((e) => (e.status || 'active') === 'active').length;
    return {
      ...r,
      keys: masked,
      keys_total: arr.length,
      keys_active,
    };
  });
  res.json({ data });
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
  if (body.name           != null) push('name', body.name);
  if (body.base_url       != null) push('base_url', body.base_url);
  if (body.api_key        != null) push('api_key', body.api_key);
  if (body.type           != null) push('type', body.type);
  if (body.status         != null) push('status', body.status);
  if (body.weight         != null) push('weight', Number(body.weight));
  if (body.priority       != null) push('priority', Number(body.priority));
  if (body.models         != null) push('models', body.models);
  if (body.group_access   != null) push('group_access', body.group_access);
  // v0.3 — new-api parity fields.
  if (body.provider_type  != null) push('provider_type', body.provider_type);
  if (body.enabled        != null) push('enabled', !!body.enabled);
  if (body.model_mapping  != null) {
    sets.push(`model_mapping = $${sets.length + 1}::jsonb`);
    vals.push(JSON.stringify(body.model_mapping));
  }
  if (body.custom_headers != null) {
    sets.push(`custom_headers = $${sets.length + 1}::jsonb`);
    vals.push(JSON.stringify(body.custom_headers));
  }

  // Bulk-replace keys[] if the caller supplied a 'keys' array. We accept
  // an array of strings (raw keys) or { key, status } objects.
  const rawKeys = (req.body as any)?.keys;
  let keysReplaced: ChannelKeyEntry[] | null = null;
  if (Array.isArray(rawKeys)) {
    keysReplaced = await replaceKeys(id, tenantId, rawKeys);
    if (keysReplaced === null) {
      res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
      return;
    }
  }

  if (sets.length === 0 && keysReplaced === null) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'no fields to update' } });
    return;
  }

  let rows: any[];
  if (sets.length > 0) {
    vals.push(id, tenantId);
    rows = await query<any>(
      `UPDATE upstream_channel SET ${sets.join(', ')}
         WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length}
       RETURNING ${SAFE_COLS}`,
      vals,
    );
    if (rows.length === 0) {
      res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
      return;
    }
  } else {
    rows = await query<any>(
      `SELECT ${SAFE_COLS} FROM upstream_channel WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
  }
  // Echo masked keys[] for the convenience of the admin UI.
  const echo = keysReplaced ?? null;
  res.json({
    ...rows[0],
    ...(echo
      ? {
          keys: echo.map((e) => ({
            preview: maskKey(e.key),
            status: e.status,
            added_at: e.added_at,
            cooled_until: e.cooled_until,
            last_error: e.last_error,
          })),
          keys_total: echo.length,
          keys_active: echo.filter((e) => (e.status || 'active') === 'active').length,
        }
      : {}),
  });
});

// =========================================================================
// Multi-key sub-routes (P1 #14) — add / remove individual keys without
// having to PATCH the whole row.
// =========================================================================

/**
 * POST /admin/channels/:id/keys
 * Body: { key: string }
 * Appends one key to keys[]. Status defaults to 'active'.
 * Returns the full masked keys[] array.
 */
channelsRouter.post('/:id/keys', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  const key = String((req.body as any)?.key ?? '');
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  if (!key || key.length < 8) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'key must be ≥8 chars' } });
    return;
  }
  const out = await addKey(id, tenantId, key);
  if (out === null) {
    res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
    return;
  }
  res.status(201).json({
    keys: out.map((e) => ({
      preview: maskKey(e.key),
      status: e.status,
      added_at: e.added_at,
      cooled_until: e.cooled_until,
      last_error: e.last_error,
    })),
    keys_total: out.length,
  });
});

/**
 * DELETE /admin/channels/:id/keys/:idx
 * Removes the key at the supplied index. Always returns the new keys[]
 * even if the index was out of range (no-op then).
 */
channelsRouter.delete('/:id/keys/:idx', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  const idx = parseInt(req.params.idx, 10);
  if (!id || Number.isNaN(idx) || idx < 0) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id or idx' } });
    return;
  }
  const out = await removeKey(id, tenantId, idx);
  if (out === null) {
    res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
    return;
  }
  res.json({
    keys: out.map((e) => ({
      preview: maskKey(e.key),
      status: e.status,
      added_at: e.added_at,
      cooled_until: e.cooled_until,
      last_error: e.last_error,
    })),
    keys_total: out.length,
  });
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

// =========================================================================
// v0.3 — Connectivity test endpoint.
// =========================================================================

/**
 * POST /admin/channels/:id/test
 * Probes the channel with a provider-specific request and persists
 * last_tested_at + last_test_result. Returns the result.
 *
 * Always 200 unless the channel doesn't exist (404). The probe itself
 * can report ok=false in the body — that's not an HTTP error, the
 * channel is just unreachable / auth-failed / etc. and the UI shows
 * a coloured badge accordingly.
 */
channelsRouter.post('/:id/test', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const id = parseInt(req.params.id, 10);
  if (!id) {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'invalid id' } });
    return;
  }
  const result = await testChannel(id, tenantId);
  if (!result) {
    res.status(404).json({ error: { type: 'not_found', message: 'channel not found' } });
    return;
  }
  logger.info({ tenantId, channelId: id, ok: result.ok, category: result.category }, 'admin:channel:test');
  res.json(result);
});
