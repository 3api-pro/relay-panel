import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { SitesService, type SitesServiceDeps } from '../sites/service.js';
import { FinanceReview, REVIEW_STATES } from './review.js';

const positive = z.coerce.number().int().min(1).max(2147483647);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, '日期无效');
const scanBody = z.object({ slug: z.string().min(1).max(100), from: date, to: date,
  page: positive.max(100000).default(1), requestId: z.string().trim().min(1).max(256).optional() }).strict()
  .refine(v => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) < 31 * 86400_000 &&
    v.to <= new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), '日期范围不得超过 31 天或包含未来日期');

function root(req: FastifyRequest) {
  if (!req.ctx) throw new ApiError(401, '未登录');
  requireRoot(req.ctx);
  return req.ctx;
}
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, '参数无效：日期范围最多 31 天，页码与版本必须为正整数，处置须填写依据');
  return result.data;
}
export function registerFinanceReviewRoutes(app: FastifyInstance, deps: SitesServiceDeps) {
  const service = new FinanceReview(deps.db, new SitesService(deps));
  const base = '/api/admin/finance-review';
  app.get(base, async req => {
    const ctx = root(req);
    const query = parse(z.object({ state: z.enum(REVIEW_STATES).optional(), siteId: positive.optional(), page: positive.default(1) }), req.query);
    return service.list(ctx, query.state, query.siteId, query.page);
  });
  app.get(`${base}/:id`, async req => {
    const ctx = root(req);
    return service.detail(ctx, parse(z.object({ id: positive }), req.params).id);
  });
  app.post(`${base}/scan`, async req => {
    const ctx = root(req);
    const { slug, from, to, page, requestId } = parse(scanBody, req.body);
    return service.scan(ctx, slug, { from, to, page, ...(requestId ? { requestId } : {}) });
  });
  app.post(`${base}/:id/recheck`, async req => {
    const ctx = root(req);
    const id = parse(z.object({ id: positive }), req.params).id;
    const { version } = parse(z.object({ version: positive }).strict(), req.body);
    return service.recheck(ctx, id, version);
  });
  app.post(`${base}/:id/review`, async req => {
    const ctx = root(req);
    const id = parse(z.object({ id: positive }), req.params).id;
    const body = parse(z.object({ version: positive, state: z.enum(REVIEW_STATES), note: z.string().trim().min(1).max(2000) }).strict(), req.body);
    return service.review(ctx, id, body.version, body.state, body.note);
  });
}
