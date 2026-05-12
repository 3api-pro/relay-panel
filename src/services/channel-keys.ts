/**
 * Channel multi-key rotation + cool-down (P1 #14).
 *
 * upstream_channel.keys is a JSONB array of entries:
 *   {
 *     key:          string,
 *     status:       'active' | 'dead' | 'disabled',
 *     added_at:     ISO 8601,
 *     cooled_until: ISO 8601 | null,
 *     last_error:   string | null
 *   }
 *
 * The channel also stores `current_key_idx` so round-robin survives across
 * requests. Picker is plain round-robin: every successful pick advances
 * the cursor by 1 (mod active-key count) and writes it back. Failed picks
 * mark the chosen entry dead with a `cooled_until = NOW() + 90s`, then
 * advance and try again.
 *
 * Legacy fallback: if keys[] is empty, callers should use the legacy
 * `api_key` column (handled by relay.ts).
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from './database';
import { logger } from './logger';

const COOL_DOWN_SECONDS = 90;

export interface ChannelKeyEntry {
  key: string;
  status: 'active' | 'dead' | 'disabled';
  added_at?: string | null;
  cooled_until?: string | null;
  last_error?: string | null;
}

export interface ChannelKeysRow {
  id: number;
  tenant_id: number;
  base_url: string;
  api_key: string;
  keys: ChannelKeyEntry[];
  current_key_idx: number;
}

/**
 * Is this entry currently usable? An entry is usable when:
 *   - status === 'active', AND
 *   - cooled_until is null or in the past.
 *
 * Note that we deliberately do NOT auto-resurrect dead entries: a `dead`
 * status persists until an admin re-enables it. The cooled_until field
 * is only consulted for entries whose status is still 'active' but were
 * placed on a short cooldown after a transient failure.
 */
export function isKeyUsable(entry: ChannelKeyEntry, now: Date = new Date()): boolean {
  if (entry.status !== 'active') return false;
  if (!entry.cooled_until) return true;
  return new Date(entry.cooled_until).getTime() <= now.getTime();
}

/**
 * Pick the next usable key for a channel. Atomically advances
 * current_key_idx and returns the key.
 *
 * Locks the channel row for the duration so concurrent callers don't
 * pick the same slot. Returns null if no usable key exists; caller
 * should then surface a 503 "all keys cooled / dead".
 *
 * If the channel has no `keys[]` (legacy single-key row), the caller
 * is expected to fall back to channel.api_key — we return null here
 * so the legacy path stays explicit.
 */
export async function pickKey(channelId: number): Promise<{
  key: string;
  index: number;
} | null> {
  return withTransaction(async (client) => {
    const r = await client.query<ChannelKeysRow>(
      `SELECT id, tenant_id, base_url, api_key,
              COALESCE(keys, '[]'::jsonb) AS keys,
              COALESCE(current_key_idx, 0) AS current_key_idx
         FROM upstream_channel
        WHERE id = $1
        FOR UPDATE`,
      [channelId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const keys = Array.isArray(row.keys) ? row.keys : [];
    if (keys.length === 0) return null;

    const now = new Date();
    const start = ((row.current_key_idx ?? 0) % keys.length + keys.length) % keys.length;
    for (let i = 0; i < keys.length; i++) {
      const idx = (start + i) % keys.length;
      if (isKeyUsable(keys[idx], now)) {
        const nextIdx = (idx + 1) % keys.length;
        await client.query(
          `UPDATE upstream_channel SET current_key_idx = $1 WHERE id = $2`,
          [nextIdx, channelId],
        );
        return { key: keys[idx].key, index: idx };
      }
    }
    return null;
  });
}

/**
 * Mark a specific key entry as dead (or cooled, depending on `mode`).
 *
 * mode='cool'  — 90-second cooldown but status stays 'active'.
 *                Used for transient errors (429, 502, 503, 504, fetch
 *                network errors). Auto-recovers when the cooldown lapses.
 * mode='dead'  — status flipped to 'dead'. Requires admin to re-enable.
 *                Used for 401/403 (key revoked / wrong).
 */
export async function reportKeyFailure(
  channelId: number,
  index: number,
  mode: 'cool' | 'dead',
  lastError: string,
): Promise<void> {
  try {
    await withTransaction(async (client: PoolClient) => {
      const r = await client.query<ChannelKeysRow>(
        `SELECT id, COALESCE(keys, '[]'::jsonb) AS keys
           FROM upstream_channel
          WHERE id = $1
          FOR UPDATE`,
        [channelId],
      );
      if (r.rows.length === 0) return;
      const keys = Array.isArray(r.rows[0].keys) ? r.rows[0].keys : [];
      if (index < 0 || index >= keys.length) return;

      const cooledUntil =
        mode === 'cool'
          ? new Date(Date.now() + COOL_DOWN_SECONDS * 1000).toISOString()
          : null;
      const next: ChannelKeyEntry = {
        ...keys[index],
        status: mode === 'dead' ? 'dead' : keys[index].status,
        cooled_until: cooledUntil,
        last_error: lastError.slice(0, 256),
      };
      keys[index] = next;

      await client.query(
        `UPDATE upstream_channel SET keys = $1::jsonb WHERE id = $2`,
        [JSON.stringify(keys), channelId],
      );
      logger.info(
        { channelId, index, mode, last_error: next.last_error },
        'channel-keys:report_failure',
      );
    });
  } catch (err: any) {
    // Telemetry-style helper — never throw back into the relay path.
    logger.warn({ err: err.message, channelId, index, mode }, 'channel-keys:report_failure:swallowed');
  }
}

/**
 * HTTP status → failure mode classifier. Anything 401/403 is hard-dead
 * (auth-style failure). Other 4xx is treated as transient cool-down
 * (rate-limit, quota). 5xx is also cool-down. Network errors come in
 * via reportKeyFailureFromError().
 */
export function classifyHttpFailure(status: number): 'cool' | 'dead' | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'dead';
  if (status === 429 || (status >= 500 && status < 600)) return 'cool';
  return null; // 400, 404, etc. — caller's fault, not the key's
}

/**
 * Admin-side: add a key to a channel. Defaults status='active'.
 * Returns the updated keys array.
 */
export async function addKey(
  channelId: number,
  tenantId: number,
  key: string,
): Promise<ChannelKeyEntry[] | null> {
  const r = await query<{ keys: ChannelKeyEntry[] }>(
    `UPDATE upstream_channel
        SET keys = COALESCE(keys, '[]'::jsonb) ||
                   jsonb_build_array(jsonb_build_object(
                     'key',          $1::text,
                     'status',       'active',
                     'added_at',     to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'cooled_until', NULL,
                     'last_error',   NULL
                   ))
      WHERE id = $2 AND tenant_id = $3
      RETURNING COALESCE(keys, '[]'::jsonb) AS keys`,
    [key, channelId, tenantId],
  );
  return r.length > 0 ? (r[0].keys as ChannelKeyEntry[]) : null;
}

/**
 * Admin-side: remove a key by index. Returns the updated keys array.
 * Resets current_key_idx if the deletion would push it out of bounds.
 */
export async function removeKey(
  channelId: number,
  tenantId: number,
  index: number,
): Promise<ChannelKeyEntry[] | null> {
  return withTransaction(async (client) => {
    const r = await client.query<ChannelKeysRow>(
      `SELECT id, COALESCE(keys, '[]'::jsonb) AS keys,
              COALESCE(current_key_idx, 0) AS current_key_idx
         FROM upstream_channel
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [channelId, tenantId],
    );
    if (r.rows.length === 0) return null;
    const keys = Array.isArray(r.rows[0].keys) ? r.rows[0].keys : [];
    if (index < 0 || index >= keys.length) return keys;
    keys.splice(index, 1);
    const newIdx =
      keys.length === 0 ? 0 : Math.min(r.rows[0].current_key_idx, keys.length - 1);
    await client.query(
      `UPDATE upstream_channel SET keys = $1::jsonb, current_key_idx = $2 WHERE id = $3`,
      [JSON.stringify(keys), newIdx, channelId],
    );
    return keys;
  });
}

/**
 * Admin-side: bulk-replace keys[] for a channel.
 * Used by PATCH /admin/channels/:id when the request body includes a
 * `keys` array (each item: string | { key, status? }).
 */
export async function replaceKeys(
  channelId: number,
  tenantId: number,
  rawKeys: Array<string | { key: string; status?: string }>,
): Promise<ChannelKeyEntry[] | null> {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const normalised: ChannelKeyEntry[] = rawKeys
    .map((k): ChannelKeyEntry => {
      if (typeof k === 'string') {
        return { key: k, status: 'active', added_at: nowIso, cooled_until: null, last_error: null };
      }
      const status: ChannelKeyEntry['status'] =
        k.status === 'dead' || k.status === 'disabled' ? k.status : 'active';
      return { key: String(k.key || ''), status, added_at: nowIso, cooled_until: null, last_error: null };
    })
    .filter((e) => e.key.length > 0);
  const r = await query<{ keys: ChannelKeyEntry[] }>(
    `UPDATE upstream_channel
        SET keys = $1::jsonb,
            current_key_idx = 0
      WHERE id = $2 AND tenant_id = $3
      RETURNING COALESCE(keys, '[]'::jsonb) AS keys`,
    [JSON.stringify(normalised), channelId, tenantId],
  );
  return r.length > 0 ? (r[0].keys as ChannelKeyEntry[]) : null;
}

/**
 * Safe key preview for read APIs — never leak the full value.
 * "sk-relay-..." → "sk-rel…ab12"; short keys → "…"
 */
export function maskKey(k: string): string {
  if (!k) return '';
  if (k.length > 12) return `${k.slice(0, 6)}…${k.slice(-4)}`;
  return '…';
}
