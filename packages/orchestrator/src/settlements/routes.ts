import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Orm } from '../db/client.js';
import { ApiError, type SessionCtx } from '../auth/rbac.js';
import { normalizeEmail } from '../auth/ratelimit.js';
import { securityLimit } from '../auth/security.js';
import { csvCell } from '../billing/aftercare.js';
import { accessContext, ownedSite } from '../services/collaboration.js';
import { auditEvents, financeSubmissions, operators, serviceAccess, servicePartners, sites, settlementStatements as statements, settlementShares as shares, settlementReceipts as receipts, settlementEvents as events } from '../db/schema.js';
import { activePartner, activeSite, balance, change, day, decimal, draftInput, event, grantMatches, id, memberStatement, micros, now, ownerStatement, parse, positiveMoney, priced, publicReceipt, publicShare, publicStatement, today, version, type Statement } from './domain.js';
const ownerBase = '/api/services/settlements', memberBase = '/api/collaboration/settlements';
const revision = z.number().int().positive();
const reasonBody = z.object({ version: revision, reason: z.string().trim().min(5).max(2000) }).strict();
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registerSettlementRoutes(app: FastifyInstance, { db }: { db: Db }) {
  async function source(orm: Orm, ctx: SessionCtx, reviewId: number) {
    const [first] = await orm.select().from(financeSubmissions).where(eq(financeSubmissions.id, reviewId));
    if (!first) throw new ApiError(404, '账目复核不存在');
    const grant = await accessContext(orm, ctx, first.accessId, true, true, true);
    await activeSite(orm, grant.access.siteId, grant.access.ownerId);
    const [r] = await orm.select().from(financeSubmissions).where(eq(financeSubmissions.id, reviewId)).for('share');
    if (!r || r.status !== 'accepted' || grant.access.role !== 'finance' || !r.report.scope.costs || r.report.supplierCostUsd == null || !positiveMoney.safeParse(r.report.supplierCostUsd).success) throw new ApiError(400, '仅可引用已确认且含正数上游成本的账目快照');
    return { siteId: grant.access.siteId, reviewId, evidence: r.report, amount: r.report.supplierCostUsd };
  }
  app.get<{ Params: { id: string } }>(`${ownerBase}/sources/:id`, async req => db.orm.transaction(orm => source(orm, req.ctx!, parse(id, req.params.id))));
  app.get(ownerBase, async req => {
    const q = parse(z.object({ siteId: id, beforeId: id.optional(), status: z.enum(['draft','issued','cancelled']).optional() }).strict(), req.query);
    const site = await ownedSite(db.orm, req.ctx!, q.siteId);
    const rows = await db.orm.select().from(statements).where(and(eq(statements.siteId, site.id), eq(statements.ownerId, site.operatorId), q.status ? eq(statements.status, q.status) : undefined, q.beforeId ? lt(statements.id, q.beforeId) : undefined)).orderBy(desc(statements.id)).limit(51);
    return { items: rows.slice(0, 50).map(publicStatement), hasMore: rows.length > 50 };
  });
  app.post(ownerBase, async (req, reply) => {
    const b = parse(draftInput, req.body), ctx = req.ctx!; if (b.version !== 0) throw new ApiError(400, '新建结算单版本必须为零');
    await securityLimit(db, `settlement-create:${ctx.operatorId}`, 60, 3600000);
    const item = await db.orm.transaction(async orm => {
      // Source grant first: matches revocation and finance review lock order.
      const src = b.sourceReviewId ? await source(orm, ctx, b.sourceReviewId) : null;
      const authorized = await ownedSite(orm, ctx, b.siteId); const site = await activeSite(orm, b.siteId, authorized.operatorId), partner = await activePartner(orm, b.siteId, b.partnerId);
      if (src && (src.siteId !== b.siteId || b.currency !== 'USD' || b.direction !== 'payable' || b.fromDay !== src.evidence.scope.fromDay || b.toDay !== src.evidence.scope.toDay)) throw new ApiError(400, '引用成本快照时，站点、USD 应付方向和账期必须匹配');
      const [created] = await orm.insert(statements).values({ ...b, ...priced(b.lines), ownerId: site.operatorId, partnerName: partner.name, version: 1, createdBy: ctx.operatorId, sourceEvidence: src?.evidence ?? null }).onConflictDoNothing().returning();
      if (!created) throw new ApiError(409, '该伙伴单号或账目快照已建立结算单，请查看原单');
      await event(orm, created, ctx, 'created', '创建结算草稿'); return publicStatement(created);
    }); return reply.code(201).send({ item });
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id`, async req => {
    const b = parse(draftInput, req.body), ctx = req.ctx!;
    return db.orm.transaction(async orm => {
      const s = await ownerStatement(orm, ctx, parse(id, req.params.id)); version(s, b.version);
      if (s.status !== 'draft' || b.siteId !== s.siteId || b.partnerId !== s.partnerId || b.reference !== s.reference || b.sourceReviewId !== s.sourceReviewId) throw new ApiError(409, '仅草稿可编辑，站点、伙伴、单号和来源不可更换');
      if (s.sourceEvidence && (b.currency !== 'USD' || b.direction !== 'payable' || b.fromDay !== s.sourceEvidence.scope.fromDay || b.toDay !== s.sourceEvidence.scope.toDay)) throw new ApiError(400, '引用快照的币种、方向与账期不可更换');
      const p = await activePartner(orm, s.siteId, s.partnerId);
      return { item: publicStatement(await change(orm, s, ctx, 'edited', '更新结算草稿', { ...b, ...priced(b.lines), partnerName: p.name })) };
    });
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id/issue`, async req => {
    const b = parse(z.object({ version: revision, acknowledge: z.literal(true) }).strict(), req.body), ctx = req.ctx!;
    return db.orm.transaction(async orm => {
      const s = await ownerStatement(orm, ctx, parse(id, req.params.id)); version(s, b.version);
      if (s.status !== 'draft') throw new ApiError(409, '仅草稿可确认出单'); await activePartner(orm, s.siteId, s.partnerId);
      return { item: publicStatement(await change(orm, s, ctx, 'issued', '确认金额与依据并出单；不代表已支付', { status: 'issued', issuedAt: now() })) };
    });
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id/cancel`, async req => {
    const b = parse(reasonBody, req.body), ctx = req.ctx!;
    return db.orm.transaction(async orm => {
      const s = await ownerStatement(orm, ctx, parse(id, req.params.id)); version(s, b.version);
      if (s.status === 'cancelled' || micros((await balance(orm, s)).recorded) !== 0n) throw new ApiError(409, '已有有效回执或结算单已取消；请先核实并更正回执记录');
      return { item: publicStatement(await change(orm, s, ctx, 'cancelled', b.reason, { status: 'cancelled', cancelledAt: now(), cancelReason: b.reason })) };
    });
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id/receipts`, async (req, reply) => {
    const b = parse(z.object({ version: revision, amount: positiveMoney, reference: z.string().trim().min(3).max(160), method: z.string().trim().min(2).max(80), receivedDay: day.refine(d => d <= today()), note: z.string().trim().max(2000), acknowledge: z.literal(true) }).strict(), req.body), ctx = req.ctx!;
    const item = await db.orm.transaction(async orm => {
      const s = await ownerStatement(orm, ctx, parse(id, req.params.id)); version(s, b.version);
      if (s.status !== 'issued') throw new ApiError(409, '只有已出单的结算单可登记回执');
      const totals = await balance(orm, s); if (micros(b.amount) > micros(totals.remaining)) throw new ApiError(400, '回执金额超过未登记金额');
      const [count] = await orm.select({ n: sql<number>`count(*)::int` }).from(receipts).where(eq(receipts.statementId, s.id));
      if (count!.n >= 1000) throw new ApiError(400, '每张结算单最多登记一千条回执记录');
      const [r] = await orm.insert(receipts).values({ statementId: s.id, ownerId: s.ownerId, amount: decimal(micros(b.amount)), reference: b.reference, method: b.method, receivedDay: b.receivedDay, note: b.note, recordedBy: ctx.operatorId }).onConflictDoNothing().returning();
      if (!r) throw new ApiError(409, '该回执编号已有有效记录，不可重复或跨单登记');
      await change(orm, s, ctx, 'receipt.recorded', `登记回执 #${r.id}`); return publicReceipt(r);
    }); return reply.code(201).send({ item });
  });
  app.post<{ Params: { id: string; receipt: string } }>(`${ownerBase}/:id/receipts/:receipt/void`, async req => {
    const b = parse(reasonBody, req.body), ctx = req.ctx!;
    return db.orm.transaction(async orm => {
      const s = await ownerStatement(orm, ctx, parse(id, req.params.id)); version(s, b.version);
      const [r] = await orm.update(receipts).set({ voidedAt: now(), voidReason: b.reason }).where(and(eq(receipts.id, parse(id, req.params.receipt)), eq(receipts.statementId, s.id), isNull(receipts.voidedAt))).returning();
      if (!r) throw new ApiError(409, '回执不存在或已作废'); await change(orm, s, ctx, 'receipt.voided', b.reason); return { item: publicReceipt(r) };
    });
  });
  async function sharing(orm: Orm, ctx: SessionCtx, statementId: number, accessId: number) {
    const grant = await accessContext(orm, ctx, accessId, true, true), s = await ownerStatement(orm, ctx, statementId); grantMatches(grant, s);
    if (s.status !== 'issued' || !grant.access.acceptedAt || !grant.access.operatorId) throw new ApiError(409, '请先出单，并选择已接受邀请的协作者');
    const [op] = await orm.select().from(operators).where(eq(operators.id, grant.access.operatorId));
    if (!op || op.status !== 'active' || !op.emailVerifiedAt || normalizeEmail(op.email) !== grant.access.email) throw new ApiError(409, '协作者账号当前不可用');
    const recipient = { accessId, email: grant.access.email, role: grant.access.role };
    const document = publicStatement(s), totals = await balance(orm, s);
    // All subsequent public receipt records are included by this explicit sharing scope.
    const recent = await orm.select().from(receipts).where(eq(receipts.statementId, s.id)).orderBy(desc(receipts.id)).limit(21);
    const preview = { document, balance: totals, recipient, receipts: recent.slice(0,20).map(publicReceipt), hasOlderReceipts: recent.length > 20 };
    return { s, preview, confirmation: sha([document, recipient, totals, preview.receipts]) };
  }
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id/share-preview`, async req => {
    const b = parse(z.object({ accessId: id }).strict(), req.body);
    return db.orm.transaction(async orm => { const r = await sharing(orm, req.ctx!, parse(id, req.params.id), b.accessId); return { ...r.preview, confirmation: r.confirmation }; });
  });
  app.post<{ Params: { id: string } }>(`${ownerBase}/:id/shares`, async (req, reply) => {
    const b = parse(z.object({ accessId: id, confirmation: z.string().regex(/^[a-f0-9]{64}$/), acknowledge: z.literal(true) }).strict(), req.body), ctx = req.ctx!;
    const item = await db.orm.transaction(async orm => {
      const r = await sharing(orm, ctx, parse(id, req.params.id), b.accessId);
      if (r.confirmation !== b.confirmation) throw new ApiError(409, '共享预览已变化，请重新预览');
      const [created] = await orm.insert(shares).values({ statementId: r.s.id, accessId: b.accessId, sharedBy: ctx.operatorId }).onConflictDoNothing().returning();
      if (!created) throw new ApiError(409, '已向此身份共享，请查看现有授权');
      await event(orm, r.s, ctx, 'shared', '明确共享结算单与回执记录', created.id); return publicShare(created);
    }); return reply.code(201).send({ item });
  });
  app.delete<{ Params: { id: string; share: string } }>(`${ownerBase}/:id/shares/:share`, async req => {
    const ctx = req.ctx!, shareId = parse(id, req.params.share), statementId = parse(id, req.params.id);
    return db.orm.transaction(async orm => {
      const [first] = await orm.select().from(shares).where(and(eq(shares.id, shareId), eq(shares.statementId, statementId)));
      if (!first) throw new ApiError(404, '共享记录不存在');
      await accessContext(orm, ctx, first.accessId, true, true, true); const s = await ownerStatement(orm, ctx, statementId);
      const [r] = await orm.update(shares).set({ revokedAt: now(), updatedAt: now(), version: sql`${shares.version}+1` }).where(and(eq(shares.id, shareId), isNull(shares.revokedAt))).returning();
      if (!r) throw new ApiError(409, '共享已撤销'); await event(orm, s, ctx, 'share.revoked', '撤销单张结算单共享', shareId); return { item: publicShare(r) };
    });
  });
  app.get<{ Params: { id: string } }>(`${ownerBase}/:id/shares`, async req => db.orm.transaction(async orm => {
    const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query), s = await ownerStatement(orm, req.ctx!, parse(id, req.params.id));
    const rows = await orm.select({ share: shares, email: serviceAccess.email }).from(shares).innerJoin(serviceAccess, eq(serviceAccess.id, shares.accessId)).where(and(eq(shares.statementId, s.id), q.beforeId ? lt(shares.id,q.beforeId) : undefined)).orderBy(desc(shares.id)).limit(51);
    return { items: rows.slice(0,50).map(r => ({ ...publicShare(r.share), email: r.email, accessId: r.share.accessId })), hasMore: rows.length>50 };
  }));
  for (const staff of [true,false]) {
    const base = staff ? ownerBase : memberBase;
    const context = async (orm: Orm, ctx: SessionCtx, resource: number) => staff ? { statement: await ownerStatement(orm,ctx,resource), share: null } : memberStatement(orm,ctx,resource);
    app.get<{ Params: { id: string } }>(`${base}/:id`, async req => db.orm.transaction(async orm => {
      const r = await context(orm,req.ctx!,parse(id,req.params.id)), s = r.statement;
      return { item: publicStatement(s), balance: await balance(orm,s), ...(staff ? { internal: { siteId: s.siteId, partnerId: s.partnerId, internalNote: s.internalNote, sourceReviewId: s.sourceReviewId, sourceEvidence: s.sourceEvidence } } : { share: publicShare(r.share!) }) };
    }));
    app.get<{ Params: { id: string } }>(`${base}/:id/receipts`, async req => db.orm.transaction(async orm => {
      const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query), { statement:s } = await context(orm,req.ctx!,parse(id,req.params.id));
      const rows = await orm.select().from(receipts).where(and(eq(receipts.statementId,s.id),q.beforeId ? lt(receipts.id,q.beforeId) : undefined)).orderBy(desc(receipts.id)).limit(51);
      return { items: rows.slice(0,50).map(publicReceipt), hasMore: rows.length>50 };
    }));
    app.get<{ Params: { id: string } }>(`${base}/:id/events`, async req => db.orm.transaction(async orm => {
      const q = parse(z.object({ beforeId: id.optional() }).strict(), req.query), r = await context(orm,req.ctx!,parse(id,req.params.id));
      const rows = await orm.select().from(events).where(and(eq(events.statementId,r.statement.id), staff ? undefined : eq(events.shareId,r.share!.id),q.beforeId ? lt(events.id,q.beforeId) : undefined)).orderBy(desc(events.id)).limit(51);
      return { items: rows.slice(0,50).map(e => ({ id:e.id,action:e.action,note:e.note,createdAt:e.createdAt })),hasMore:rows.length>50 };
    }));
    app.get<{ Params: { id: string } }>(`${base}/:id/export.csv`, async(req,reply) => {
      const data = await db.orm.transaction(async orm => {
        const { statement:s } = await context(orm,req.ctx!,parse(id,req.params.id)), totals = await balance(orm,s);
        const records = await orm.select().from(receipts).where(eq(receipts.statementId,s.id)).orderBy(asc(receipts.id)).limit(1000);
        await orm.insert(auditEvents).values({siteId:s.siteId,actor:req.ctx!.email,action:'settlement.export',payload:{statementId:s.id},ok:true});
        return [['Statement',s.reference],['Title',s.title],['Partner',s.partnerName],['Direction',s.direction],['Currency',s.currency],['Period',s.fromDay,s.toDay],['Due',s.dueDay],['Status',s.status],['Public note',s.publicNote],['Total',s.total],['Recorded receipts',totals.recorded],['Unrecorded',totals.remaining],['Proof','Operator-recorded; not provider-verified'],[],['Line','Amount'],...s.lines.map(l=>[l.label,l.amount]),[],['Receipt','Date','Method','Amount','Note','Voided at','Reason'],...records.map(r=>[r.reference,r.receivedDay,r.method,r.amount,r.note,r.voidedAt,r.voidReason])];
      }); return reply.header('Cache-Control','no-store').header('Content-Disposition','attachment; filename="settlement.csv"').type('text/csv; charset=utf-8').send('\ufeff'+data.map(r=>r.map(csvCell).join(',')).join('\r\n'));
    });
  }
  app.get(memberBase, async req => {
    const ctx=req.ctx!, q=parse(z.object({beforeId:id.optional()}).strict(),req.query); if(ctx.role!=='operator')return{items:[],hasMore:false};
    const [op]=await db.orm.select({verified:operators.emailVerifiedAt}).from(operators).where(eq(operators.id,ctx.operatorId));if(!op?.verified)return{items:[],hasMore:false};
    const rows=await db.orm.select({statement:statements,share:shares}).from(shares).innerJoin(statements,eq(statements.id,shares.statementId)).innerJoin(serviceAccess,eq(serviceAccess.id,shares.accessId)).innerJoin(sites,eq(sites.id,statements.siteId)).innerJoin(operators,eq(operators.id,statements.ownerId)).leftJoin(servicePartners,eq(servicePartners.id,serviceAccess.partnerId))
      .where(and(isNull(shares.revokedAt),sql`${statements.status}<>'draft'`,eq(serviceAccess.operatorId,ctx.operatorId),eq(serviceAccess.email,normalizeEmail(ctx.email)),isNotNull(serviceAccess.acceptedAt),isNull(serviceAccess.revokedAt),gt(serviceAccess.expiresAt,now()),eq(serviceAccess.siteId,statements.siteId),eq(serviceAccess.ownerId,statements.ownerId),eq(sites.operatorId,statements.ownerId),sql`${sites.status}<>'destroyed'`,eq(operators.status,'active'),inArray(serviceAccess.role,['supplier','reseller','finance']),sql`(${serviceAccess.role}='finance' OR ${serviceAccess.partnerId}=${statements.partnerId})`,sql`(${serviceAccess.partnerId} IS NULL OR (${serviceAccess.partnerId}=${statements.partnerId} AND ${servicePartners.siteId}=${statements.siteId} AND ${servicePartners.status}='active'))`,q.beforeId?lt(shares.id,q.beforeId):undefined)).orderBy(desc(shares.id)).limit(51);
    return{items:rows.slice(0,50).map(r=>({item:publicStatement(r.statement),share:publicShare(r.share)})),hasMore:rows.length>50};
  });
  app.post<{Params:{id:string}}>(`${memberBase}/:id/respond`,async req=>{
    const b=parse(z.object({version:revision,status:z.enum(['acknowledged','disputed']),note:z.string().trim().min(5).max(2000)}).strict(),req.body),ctx=req.ctx!;
    await securityLimit(db,`settlement-response:${ctx.operatorId}`,60,3600000);
    return db.orm.transaction(async orm=>{
      const {statement:s,share}=await memberStatement(orm,ctx,parse(id,req.params.id));if(s.status!=='issued'||share.version!==b.version)throw new ApiError(409,'结算单或回复已变化，请刷新');
      const [r]=await orm.update(shares).set({status:b.status,note:b.note,version:share.version+1,updatedAt:now()}).where(eq(shares.id,share.id)).returning();
      await event(orm,s,ctx,`share.${b.status}`,b.note,share.id);return{share:publicShare(r!)};
    });
  });
}
