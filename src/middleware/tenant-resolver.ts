import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { query } from '../services/database';
import { logger } from '../services/logger';

/**
 * Resolve req.tenantId.
 * - single mode: always tenantId = 1
 * - multi mode: parse Host header, lookup by slug or custom_domain
 */
export async function tenantResolver(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (config.tenantMode === 'single') {
    req.tenantId = 1;
    return next();
  }

  const host = (req.hostname || '').toLowerCase();
  if (!host) {
    res.status(400).json({ error: { type: 'bad_request', message: 'Missing Host header' } });
    return;
  }

  const saasDomain = (config.saasDomain || '').toLowerCase();
  let slug: string | null = null;
  let customDomain: string | null = null;

  if (saasDomain && (host === saasDomain || host === `www.${saasDomain}`)) {
    res.status(404).json({ error: { type: 'not_found', message: 'No tenant for root domain' } });
    return;
  }

  if (saasDomain && host.endsWith(`.${saasDomain}`)) {
    slug = host.slice(0, -(saasDomain.length + 1)).toLowerCase();
  } else {
    customDomain = host;
  }

  try {
    const rows = slug
      ? await query<{ id: number }>(
          `SELECT id FROM tenant WHERE slug = $1 AND status = 'active' LIMIT 1`,
          [slug],
        )
      : await query<{ id: number }>(
          `SELECT id FROM tenant WHERE custom_domain = $1 AND status = 'active' LIMIT 1`,
          [customDomain],
        );

    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: { type: 'not_found', message: `Unknown tenant for host: ${host}` } });
      return;
    }
    req.tenantId = rows[0].id;
    next();
  } catch (err: any) {
    logger.error({ err: err.message, host }, 'tenant-resolver:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Tenant resolution failed' } });
  }
}
