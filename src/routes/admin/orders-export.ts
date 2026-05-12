/**
 * Admin bulk CSV export (v0.5).
 *
 * GET /api/admin/orders/export?format=csv&from=<iso>&to=<iso>&status=<status>
 *
 * Streams orders as CSV via a PG cursor so memory stays bounded even for
 * millions of rows. Columns:
 *   id, created_at, end_user_email, plan_slug, amount_cents, status,
 *   payment_provider, paid_at
 *
 * Filters (all optional):
 *   - from   ISO 8601 timestamp (inclusive)
 *   - to     ISO 8601 timestamp (inclusive)
 *   - status one of: pending / paid / refunded / canceled
 *
 * Content-Disposition: attachment; filename="orders-<tenant>-<stamp>.csv"
 * Tenant isolation via req.resellerAdmin.tenantId — admin can only export
 * their own tenant's orders.
 *
 * Note: TanStack table button on /admin/orders currently does client-side
 * CSV via downloadCsv() in the page. UI wiring to this endpoint is
 * deferred to v0.5.1 to avoid stomping the i18n-cleanup agent's edits.
 */
import { Router, Request, Response } from 'express';
import { getPool } from '../../services/database';
import { logger } from '../../services/logger';

export const adminOrdersExportRouter = Router();

const COLUMNS = [
  'id',
  'created_at',
  'end_user_email',
  'plan_slug',
  'plan_name',
  'amount_cents',
  'currency',
  'status',
  'payment_provider',
  'provider_txn_id',
  'paid_at',
] as const;

function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseIsoOrNull(v: any): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const VALID_STATUS = new Set(['pending', 'paid', 'refunded', 'canceled']);

adminOrdersExportRouter.get('/orders/export', async (req: Request, res: Response) => {
  const tenantId = req.resellerAdmin!.tenantId;
  const format = String(req.query.format ?? 'csv').toLowerCase();
  if (format !== 'csv') {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'format must be csv' } });
    return;
  }

  const from = parseIsoOrNull(req.query.from);
  const to = parseIsoOrNull(req.query.to);
  const statusRaw = String(req.query.status ?? '').trim();
  const status = statusRaw && VALID_STATUS.has(statusRaw) ? statusRaw : '';

  const params: any[] = [tenantId];
  let where = 'o.tenant_id = $1';
  if (from) {
    params.push(from.toISOString());
    where += ` AND o.created_at >= $${params.length}`;
  }
  if (to) {
    params.push(to.toISOString());
    where += ` AND o.created_at <= $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }

  const sql = `
    SELECT o.id, o.created_at, u.email AS end_user_email,
           p.slug AS plan_slug, p.name AS plan_name,
           o.amount_cents, o.currency, o.status,
           o.payment_provider, o.provider_txn_id, o.paid_at
      FROM orders o
 LEFT JOIN end_user u ON u.id = o.end_user_id
 LEFT JOIN plans   p ON p.id = o.plan_id
     WHERE ${where}
  ORDER BY o.id DESC
  `;

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `orders-tenant${tenantId}-${stamp}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // UTF-8 BOM for Excel.
  res.write('﻿');
  res.write(COLUMNS.join(',') + '\n');

  // Use a dedicated client + cursor so memory stays bounded.
  const client = await getPool().connect();
  let totalRows = 0;
  try {
    await client.query('BEGIN');
    // node-postgres cursor protocol via DECLARE / FETCH.
    await client.query(`DECLARE export_cur NO SCROLL CURSOR FOR ${sql}`, params);
    const FETCH_SIZE = 500;
    while (true) {
      const batch = await client.query(`FETCH ${FETCH_SIZE} FROM export_cur`);
      if ((batch.rowCount ?? 0) === 0) break;
      const lines: string[] = [];
      for (const r of batch.rows) {
        lines.push(
          [
            r.id,
            r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
            r.end_user_email,
            r.plan_slug,
            r.plan_name,
            r.amount_cents,
            r.currency,
            r.status,
            r.payment_provider,
            r.provider_txn_id,
            r.paid_at instanceof Date ? r.paid_at.toISOString() : r.paid_at,
          ].map(escapeCsv).join(','),
        );
      }
      const ok = res.write(lines.join('\n') + '\n');
      totalRows += batch.rowCount ?? 0;
      // backpressure
      if (!ok) {
        await new Promise<void>((resolve) => res.once('drain', () => resolve()));
      }
      if ((batch.rowCount ?? 0) < FETCH_SIZE) break;
    }
    await client.query('CLOSE export_cur');
    await client.query('COMMIT');
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.error({ err: err.message, tenantId }, 'admin:orders:export:error');
    // Headers already sent — best we can do is end the stream.
    if (!res.headersSent) {
      res.status(500).json({ error: { type: 'internal_error', message: 'export failed' } });
      client.release();
      return;
    }
  } finally {
    client.release();
  }

  res.end();
  logger.info({ tenantId, rows: totalRows, from, to, status }, 'admin:orders:export:done');
});
