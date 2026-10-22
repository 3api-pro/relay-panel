import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { observedRequests, observationRuns, serviceWork, serviceEvents, servicePartners, servicePublications, supportTickets, sites, appSettings } from '../db/schema.js';
import { ApiError, requireWrite, canAccessSite, type SessionCtx } from '../auth/rbac.js';
import { toPgTimestamp } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { securityLimit } from '../auth/security.js';
import { csvCell } from '../billing/aftercare.js';
import type { SitesServiceDeps } from '../sites/service.js';
import { Observations, beijingDay } from './observations.js';

const kinds = ['incident','billing_review','maintenance','upgrade','recovery','quote','settlement','onboarding'] as const;
const statuses = ['open','investigating','waiting','resolved','closed','cancelled'] as const;
const transitions: Record<string, readonly string[]> = {open:['investigating','waiting','cancelled'],investigating:['waiting','resolved','cancelled'],waiting:['investigating','resolved','cancelled'],resolved:['closed','investigating'],closed:['investigating'],cancelled:['open']};
export const checklists: Record<typeof kinds[number], string[]> = {
  incident:['scope','evidence','mitigation','verification'], billing_review:['source','rate','supplier','decision'],
  maintenance:['scope','notice','backup','verification'], upgrade:['compatibility','backup','migration','rollback','verification'],
  recovery:['backup_scope','checksum','encryption_key','isolated_restore','business_verification'],
  quote:['scope','currency','validity','acceptance'], settlement:['source','adjustments','receipt','reconciliation'],
  onboarding:['endpoint','protocol','model','client_config','customer_verification'],
};
const details = z.object({reference:z.string().trim().max(200).optional(),amount:z.number().finite().nonnegative().max(1e10).optional(),
  currency:z.enum(['USD','CNY','EUR','USDT']).optional(),validFrom:z.string().datetime({offset:true}).optional(),validTo:z.string().datetime({offset:true}).optional(),
  receipt:z.string().trim().max(200).optional(),checks:z.array(z.string().max(60)).max(12).default([]),
}).strict().refine(x=>(x.amount===undefined)===(x.currency===undefined),'金额与币种需同时填写')
  .refine(x=>(x.validFrom===undefined)===(x.validTo===undefined) && (!x.validFrom || !x.validTo || Date.parse(x.validFrom)<Date.parse(x.validTo)),'有效期需完整且结束晚于开始');
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s && s<=beijingDay() && s>=beijingDay(Date.now()-30*86400000));
const id = (value: unknown): number => { const result=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(value);if(!result.success)throw new ApiError(400,'编号无效');return result.data; };
const escapeHtml = (s:string):string=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const parse = <T extends z.ZodTypeAny>(schema:T,input:unknown):z.output<T> => {const result=schema.safeParse(input);if(!result.success)throw new ApiError(400,'填写内容无效，请检查日期、金额、必填项和字段长度');return result.data;};

export function registerServiceRoutes(app: FastifyInstance, deps: SitesServiceDeps): void {
  const { db }=deps, obs=new Observations(deps),base='/api/services';
  const audit = async(ctx:SessionCtx,action:string,payload:Record<string,unknown>)=>writeAudit(db,{actor:ctx.email,action:`services.${action}`,payload,ok:true});
  async function work(ctx:SessionCtx, value:unknown) {
    const [row]=await db.orm.select().from(serviceWork).where(eq(serviceWork.id,id(value)));
    if(!row)throw new ApiError(404,'事项不存在');await obs.site(ctx,row.siteId);return row;
  }
  async function partner(ctx:SessionCtx,value:unknown) {
    const [row]=await db.orm.select().from(servicePartners).where(eq(servicePartners.id,id(value)));
    if(!row)throw new ApiError(404,'伙伴不存在');await obs.site(ctx,row.siteId);return row;
  }
  app.get(`${base}/catalog`, async req=>({sites:(await db.orm.select().from(sites).where(sql`${sites.status}<>'destroyed'`).orderBy(asc(sites.id))).filter(s=>canAccessSite(req.ctx!,s)).map(s=>({id:s.id,label:s.label,slug:s.slug,engine:s.engine,version:s.version,managed:s.managed,status:s.status})),checklists,
    modes:{collection:'existing-logs-only',inferenceProbes:false,automaticFinancialTransfers:false,externalPartnerLogin:false},
    intervalMs:deps.config.observationIntervalMs}));
  const querySchema=z.object({siteId:z.coerce.number().int().positive(),day:daySchema,requestId:z.string().trim().min(1).max(256).optional(),channelId:z.string().trim().min(1).max(256).optional(),model:z.string().trim().min(1).max(256).optional()});
  app.get(`${base}/collection-settings`,async req=>{const q=parse(z.object({siteId:z.coerce.number().int().positive()}),req.query);await obs.site(req.ctx!,q.siteId);const [row]=await db.orm.select().from(appSettings).where(eq(appSettings.key,`passive_collection:${q.siteId}`));return{enabled:row?.value.enabled!==false,intervalMs:deps.config.observationIntervalMs};});
  app.post(`${base}/collection-settings`,async req=>{requireWrite(req.ctx!);const b=parse(z.object({siteId:z.number().int().positive(),enabled:z.boolean()}).strict(),req.body);await obs.site(req.ctx!,b.siteId);
    await db.orm.insert(appSettings).values({key:`passive_collection:${b.siteId}`,value:{enabled:b.enabled}}).onConflictDoUpdate({target:appSettings.key,set:{value:{enabled:b.enabled},updatedAt:toPgTimestamp(new Date())}});await audit(req.ctx!,'collection.settings',b);return{enabled:b.enabled};});
  app.get(`${base}/quality`,async req=>{const q=parse(querySchema,req.query);const result=await obs.report(req.ctx!,q.siteId,q.day,q);return {...result,records:result.records.slice(0,200),displayLimit:200};});
  app.post(`${base}/collect`,async req=>{requireWrite(req.ctx!);const q=parse(querySchema.pick({siteId:true,day:true}),req.body);
    await obs.site(req.ctx!,q.siteId);await securityLimit(db,`observations:${q.siteId}`,30,60000);
    const run=await obs.scan(req.ctx!,q.siteId,q.day);await audit(req.ctx!,'collect',{siteId:q.siteId,day:q.day,page:run.nextPage-1});return {run};});
  app.get(`${base}/quality.csv`,async(req,reply)=>{const q=parse(querySchema,req.query),r=await obs.report(req.ctx!,q.siteId,q.day,q);
    const rows=[['Source record','Request ID','UTC time','Channel','Model','Log type','Duration ms','First token ms','Recorded charge USD','Observed supplier cost USD','Expected charge USD','Signals'],
      ...r.records.map(x=>{const e=x.evidence;return[e.id,e.requestId,e.createdAt,e.channelId,e.model,e.outcome,e.durationMs,e.firstTokenMs,e.charge,e.supplierCost,e.expectedCharge,x.signals.join(',')];})];
    await audit(req.ctx!,'evidence.export',{siteId:q.siteId,day:q.day,rows:r.records.length,sampleLimited:r.sampleLimited});
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="observed-evidence.csv"').header('X-Sample-Limited',String(r.sampleLimited)).send('\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));});
  app.get(`${base}/work`,async req=>{const q=parse(z.object({siteId:z.coerce.number().int().positive(),beforeId:z.coerce.number().int().positive().optional()}),req.query);await obs.site(req.ctx!,q.siteId);
    const rows=await db.orm.select().from(serviceWork).where(and(eq(serviceWork.siteId,q.siteId),q.beforeId?sql`${serviceWork.id}<${q.beforeId}`:undefined)).orderBy(desc(serviceWork.id)).limit(101);
    return{items:rows.slice(0,100),hasMore:rows.length>100};});
  app.post(`${base}/work`,async(req,reply)=>{const ctx=req.ctx!;requireWrite(ctx);
    const b=parse(z.object({siteId:z.number().int().positive(),kind:z.enum(kinds),title:z.string().trim().min(3).max(160),description:z.string().trim().min(5).max(4000),
      priority:z.enum(['normal','urgent']).default('normal'),sourceId:z.number().int().positive().optional(),partnerId:z.number().int().positive().optional(),ticketId:z.number().int().positive().optional(),details:details.default({checks:[]}),}).strict(),req.body);
    const site=await obs.site(ctx,b.siteId);await securityLimit(db,`service-work:${ctx.operatorId}`,60,3600000);
    let evidence:typeof observedRequests.$inferSelect.evidence|null=null;
    if(b.sourceId){const [r]=await db.orm.select({item:observedRequests,siteId:observationRuns.siteId}).from(observedRequests).innerJoin(observationRuns,eq(observationRuns.id,observedRequests.runId)).where(eq(observedRequests.id,b.sourceId));
      if(!r||r.siteId!==b.siteId)throw new ApiError(404,'请求证据不存在');evidence=r.item.evidence;}
    if(b.partnerId && (await partner(ctx,b.partnerId)).siteId!==b.siteId)throw new ApiError(404,'伙伴不存在');
    if(b.ticketId){const [t]=await db.orm.select().from(supportTickets).where(and(eq(supportTickets.id,b.ticketId),eq(supportTickets.operatorId,site.operatorId)));if(!t)throw new ApiError(404,'工单不属于此站点工作区');}
    if(b.details.checks.some(c=>!checklists[b.kind].includes(c)))throw new ApiError(400,'检查项无效');
    const row=await db.orm.transaction(async orm=>{const [created]=await orm.insert(serviceWork).values({...b,sourceId:b.sourceId??null,partnerId:b.partnerId??null,ticketId:b.ticketId??null,evidence,createdBy:ctx.operatorId}).returning();
      await orm.insert(serviceEvents).values({workId:created!.id,actorId:ctx.operatorId,status:'open',note:'事项已创建'});return created!;});
    await audit(ctx,'work.create',{id:row.id,siteId:b.siteId,kind:b.kind});return reply.code(201).send({item:row});});
  app.get<{Params:{id:string}}>(`${base}/work/:id`,async req=>{const item=await work(req.ctx!,req.params.id);const events=await db.orm.select().from(serviceEvents).where(eq(serviceEvents.workId,item.id)).orderBy(desc(serviceEvents.id)).limit(201);return{item,events:events.slice(0,200),historyLimited:events.length>200,checklist:checklists[item.kind as typeof kinds[number]]};});
  app.post<{Params:{id:string}}>(`${base}/work/:id/events`,async req=>{const ctx=req.ctx!;requireWrite(ctx);const existing=await work(ctx,req.params.id);
    const b=parse(z.object({version:z.number().int().positive(),status:z.enum(statuses),note:z.string().trim().min(5).max(4000),details:details.optional()}).strict(),req.body);
    if(b.status!==existing.status&&!transitions[existing.status]?.includes(b.status))throw new ApiError(409,'状态转换无效，请先调查、验证再关闭');
    const nextDetails=b.details??existing.details,checks=Array.isArray(nextDetails.checks)?nextDetails.checks:[],required=checklists[existing.kind as typeof kinds[number]];
    if(checks.some(c=>typeof c!=='string'||!required.includes(c)))throw new ApiError(400,'检查项无效');
    if(['resolved','closed'].includes(b.status)) {
      if(required.some(c=>!checks.includes(c)))throw new ApiError(400,'请完成检查项并在处理记录中写明验证依据');
      if(existing.kind==='settlement'&&!nextDetails.receipt)throw new ApiError(400,'结算必须登记实际渠道回执；面板不会划款');
      if(existing.kind==='quote'&&(!nextDetails.validFrom||!nextDetails.validTo||nextDetails.amount===undefined))throw new ApiError(400,'报价需填写金额、币种和完整有效期');
    }
    const row=await db.orm.transaction(async orm=>{const [updated]=await orm.update(serviceWork).set({status:b.status,version:b.version+1,details:nextDetails,updatedAt:toPgTimestamp(new Date())}).where(and(eq(serviceWork.id,existing.id),eq(serviceWork.version,b.version))).returning();
      if(!updated)throw new ApiError(409,'事项已更新，请刷新');await orm.insert(serviceEvents).values({workId:existing.id,actorId:ctx.operatorId,status:b.status,note:b.note});return updated;});
    await audit(ctx,'work.update',{id:row.id,version:row.version,status:row.status});return{item:row};});
  app.get<{Params:{id:string}}>(`${base}/work/:id/export`,async(req,reply)=>{const item=await work(req.ctx!,req.params.id);const events=await db.orm.select({status:serviceEvents.status,note:serviceEvents.note,createdAt:serviceEvents.createdAt}).from(serviceEvents).where(eq(serviceEvents.workId,item.id)).orderBy(asc(serviceEvents.id)).limit(10001);
    await audit(req.ctx!,'work.export',{id:item.id});return reply.header('Content-Disposition',`attachment; filename="service-case-${item.id}.json"`).send({format:1,scope:'internal-workspace',item,events:events.slice(0,10000),historyLimited:events.length>10000,financialSettlementProof:'not_verified_by_panel'});});
  app.get(`${base}/partners`,async req=>{const q=parse(z.object({siteId:z.coerce.number().int().positive()}),req.query);await obs.site(req.ctx!,q.siteId);const rows=await db.orm.select().from(servicePartners).where(eq(servicePartners.siteId,q.siteId)).orderBy(desc(servicePartners.id)).limit(501);return{items:rows.slice(0,500),limited:rows.length>500};});
  const partnerBody=z.object({kind:z.enum(['supplier','reseller','operator']),name:z.string().trim().min(1).max(120),contact:z.string().trim().max(200).default(''),notes:z.string().trim().max(2000).default(''),status:z.enum(['active','archived']).default('active')});
  app.post(`${base}/partners`,async(req,reply)=>{requireWrite(req.ctx!);const b=parse(partnerBody.extend({siteId:z.number().int().positive()}).strict(),req.body);await obs.site(req.ctx!,b.siteId);await securityLimit(db,`partners:${req.ctx!.operatorId}`,50,3600000);
    const [item]=await db.orm.insert(servicePartners).values(b).returning();await audit(req.ctx!,'partner.create',{id:item!.id,siteId:b.siteId});return reply.code(201).send({item});});
  app.post<{Params:{id:string}}>(`${base}/partners/:id`,async req=>{requireWrite(req.ctx!);const old=await partner(req.ctx!,req.params.id);const b=parse(partnerBody.extend({version:z.number().int().positive()}).strict(),req.body);
    const [item]=await db.orm.update(servicePartners).set({...b,version:b.version+1,updatedAt:toPgTimestamp(new Date())}).where(and(eq(servicePartners.id,old.id),eq(servicePartners.version,b.version))).returning();if(!item)throw new ApiError(409,'伙伴已更新，请刷新');await audit(req.ctx!,'partner.update',{id:item.id});return{item};});
  app.get(`${base}/publication`,async req=>{const q=parse(z.object({siteId:z.coerce.number().int().positive()}),req.query);await obs.site(req.ctx!,q.siteId);const [item]=await db.orm.select().from(servicePublications).where(eq(servicePublications.siteId,q.siteId));return{item:item??null};});
  app.post(`${base}/publication`,async req=>{const ctx=req.ctx!;requireWrite(ctx);const b=parse(z.object({siteId:z.number().int().positive(),version:z.number().int().nonnegative(),title:z.string().trim().min(1).max(100),body:z.string().trim().min(5).max(4000),state:z.enum(['operational','degraded','maintenance']),published:z.boolean()}).strict(),req.body);
    await obs.site(ctx,b.siteId);
    const row=await db.orm.transaction(async orm=>{
      if(b.version===0){const [created]=await orm.insert(servicePublications).values({...b,version:1,token:randomUUID()}).onConflictDoNothing().returning();if(!created)throw new ApiError(409,'公告已存在，请刷新');return created;}
      const [updated]=await orm.update(servicePublications).set({...b,version:b.version+1,updatedAt:toPgTimestamp(new Date())}).where(and(eq(servicePublications.siteId,b.siteId),eq(servicePublications.version,b.version))).returning();if(!updated)throw new ApiError(409,'公告已更新，请刷新');return updated;
    });await audit(ctx,'publication.update',{siteId:b.siteId,published:b.published,version:row.version});return{item:row};});
  app.get<{Params:{token:string}}>('/public/service/:token',async(req,reply)=>{
    const valid=z.string().uuid().safeParse(req.params.token);if(!valid.success)return reply.code(404).send('Not found');
    const [row]=await db.orm.select({item:servicePublications}).from(servicePublications).innerJoin(sites,eq(sites.id,servicePublications.siteId))
      .where(and(eq(servicePublications.token,valid.data),eq(servicePublications.published,true),sql`${sites.status}<>'destroyed'`));
    if(!row)return reply.code(404).send('Not found');const item=row.item;
    reply.header('Cache-Control','no-store').header('X-Robots-Tag','noindex').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(item.title)}</title><style>body{font:16px/1.7 system-ui;background:#101827;color:#e5e7eb;margin:0;padding:32px}main{max-width:720px;margin:auto}p{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#a1aec0}</style><main><h1>${escapeHtml(item.title)}</h1><strong>${escapeHtml(item.state==='operational'?'服务正常（站长声明）':item.state==='degraded'?'服务异常':'计划维护')}</strong><p>${escapeHtml(item.body)}</p><small>发布者手动更新 · ${escapeHtml(item.updatedAt)} UTC</small></main></html>`);
  });
}
