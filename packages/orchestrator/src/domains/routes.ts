import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { sites, type SiteRow } from '../db/schema.js';
import { writeAudit } from '../audit.js';
import { ApiError, canAccessSite, requireWrite } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { applyDomains } from './caddy.js';

/**
 * 站点域名路由（规格 §9）：先写 DB（sites.domains），配置了 RP_CADDY_ADMIN_URL
 * 则同步下发 Caddy；下发失败回滚 DB 并回 502。未配置 caddy 时只记 DB。
 */

export interface DomainsRoutesDeps {
  config: Config;
  db: Db;
}

/** 规格 §9 字面 regex；入参先 trim + 小写归一 */
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN_MAX_LEN = 253;

const addBody = z.object({
  domain: z.string().min(1).max(DOMAIN_MAX_LEN),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ApiError(400, `请求参数无效: ${issues}`);
  }
  return r.data;
}

function requireCtx(req: FastifyRequest): NonNullable<FastifyRequest['ctx']> {
  const ctx = req.ctx;
  if (!ctx) throw new ApiError(401, '未登录或会话已过期');
  return ctx;
}

function normalizeDomain(raw: string): string {
  const domain = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw new ApiError(400, '域名格式无效');
  return domain;
}

export function registerDomainsRoutes(app: FastifyInstance, deps: DomainsRoutesDeps): void {
  const { config, db } = deps;

  /** 不存在与无权访问统一 404（不泄露他人站的存在性，与 sites 模块语义一致） */
  async function loadSite(req: FastifyRequest, slug: string): Promise<SiteRow> {
    const ctx = requireCtx(req);
    const row = (await db.orm.select().from(sites).where(eq(sites.slug, slug)).limit(1))[0];
    if (!row || !canAccessSite(ctx, row)) throw new ApiError(404, '站点不存在');
    return row;
  }

  /** DB 已写 next；配置了 caddy 则下发，失败回滚 DB 并抛 502 */
  async function syncCaddyOrRollback(site: SiteRow, next: string[], prev: string[]): Promise<void> {
    if (config.caddyAdminUrl === undefined) return;
    try {
      await applyDomains(config.caddyAdminUrl, site.slug, next, site.hostPort);
    } catch (err) {
      await db.orm.update(sites).set({ domains: prev }).where(eq(sites.id, site.id));
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(502, `域名下发失败，已回滚: ${msg}`);
    }
  }

  app.get<{ Params: { slug: string } }>('/api/sites/:slug/domains', async (req) => {
    const site = await loadSite(req, req.params.slug);
    return { domains: site.domains };
  });

  app.post<{ Params: { slug: string } }>('/api/sites/:slug/domains', async (req) => {
    const ctx = requireCtx(req);
    requireWrite(ctx);
    const site = await loadSite(req, req.params.slug);
    const domain = normalizeDomain(parseBody(addBody, req.body).domain);
    if (site.domains.includes(domain)) throw new ApiError(409, '域名已存在');

    const next = [...site.domains, domain];
    await db.orm
      .update(sites)
      .set({ domains: next, updatedAt: toPgTimestamp(new Date()) })
      .where(eq(sites.id, site.id));
    try {
      await syncCaddyOrRollback(site, next, site.domains);
    } catch (err) {
      await writeAudit(db, {
        siteId: site.id,
        actor: ctx.email,
        action: 'domain.add',
        payload: { slug: site.slug, domain },
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await writeAudit(db, {
      siteId: site.id,
      actor: ctx.email,
      action: 'domain.add',
      payload: { slug: site.slug, domain },
      ok: true,
    });
    return { domains: next };
  });

  app.delete<{ Params: { slug: string; domain: string } }>(
    '/api/sites/:slug/domains/:domain',
    async (req) => {
      const ctx = requireCtx(req);
      requireWrite(ctx);
      const site = await loadSite(req, req.params.slug);
      const domain = decodeURIComponent(req.params.domain).trim().toLowerCase();
      if (!site.domains.includes(domain)) throw new ApiError(404, '域名不存在');

      const next = site.domains.filter((d) => d !== domain);
      await db.orm
        .update(sites)
        .set({ domains: next, updatedAt: toPgTimestamp(new Date()) })
        .where(eq(sites.id, site.id));
      try {
        // next 为空时 applyDomains 只做删除（等价 removeDomains）
        await syncCaddyOrRollback(site, next, site.domains);
      } catch (err) {
        await writeAudit(db, {
          siteId: site.id,
          actor: ctx.email,
          action: 'domain.remove',
          payload: { slug: site.slug, domain },
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      await writeAudit(db, {
        siteId: site.id,
        actor: ctx.email,
        action: 'domain.remove',
        payload: { slug: site.slug, domain },
        ok: true,
      });
      return { domains: next };
    },
  );
}
