import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PassiveRecord } from '@relay-panel/adapter-core';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { sites, observationRuns, organizationMembers, organizations, supportTickets } from '../src/db/schema.js';
import { beijingDay, signals, summarize } from '../src/services/observations.js';
import { checklists } from '../src/services/routes.js';

describe('passive service center and workspace isolation',()=>{
  let ts:TestServer,owner:{operatorId:number;cookie:string},other:typeof owner,reader:typeof owner,viewer:typeof owner,siteId:number,foreignSiteId:number;
  let total=2,duplicate=false,fail=false,workId:number,sourceId:number,partnerId:number;
  const day=beijingDay(Date.now()-86400000);
  const record:PassiveRecord={id:'1',requestId:'r-1',createdAt:day+'T04:00:00Z',model:'m',channelId:'7',outcome:'consumption',durationMs:1200,firstTokenMs:null,inputTokens:8,outputTokens:2,charge:0,supplierCost:1,expectedCharge:2,currency:'USD',billingType:'balance'};
  const api=(path:string,body?:unknown,cookie=owner.cookie,workspace?:number)=>ts.app.inject({method:body===undefined?'GET':'POST',url:'/api/services'+path,cookies:{rp_session:cookie},...(workspace?{headers:{'x-workspace-id':String(workspace)}}:{}),...(body===undefined?{}:{payload:body})});
  beforeAll(async()=>{
    ts=await makeTestServer();owner=await ts.seedLogin({email:'service-owner@example.test',password:'long-test-password',role:'operator'});
    other=await ts.seedLogin({email:'service-other@example.test',password:'long-test-password',role:'operator'});
    reader=await ts.seedLogin({email:'service-reader@example.test',password:'long-test-password',role:'operator'});
    viewer=await ts.seedLogin({email:'service-viewer@example.test',password:'long-test-password',role:'viewer'});
    const base={engine:'sub2api',version:'1',hostPort:0,baseUrl:'http://127.0.0.1:19000',status:'active',managed:'external'};
    siteId=(await ts.db.orm.insert(sites).values({...base,operatorId:owner.operatorId,slug:'services-a',label:'Own site'}).returning())[0]!.id;
    foreignSiteId=(await ts.db.orm.insert(sites).values({...base,operatorId:other.operatorId,slug:'services-b',label:'Other site'}).returning())[0]!.id;
    await ts.db.orm.insert(organizations).values({ownerId:owner.operatorId,name:'Own workspace'});
    await ts.db.orm.insert(organizationMembers).values({ownerId:owner.operatorId,operatorId:reader.operatorId,role:'reader'});
    const connect=ts.adapters.sub2api.connect.bind(ts.adapters.sub2api);
    vi.spyOn(ts.adapters.sub2api,'connect').mockImplementation(async(...args)=>{const c=await connect(...args);c.stats.observations=async q=>{
      if(fail)throw new Error('PRIVATE upstream credentials must not be returned');const key=duplicate?'1':String(q.page);
      return {items:[{...record,id:key,requestId:'r-'+key}],sourceIds:[key],total,page:q.page,pages:2,sourceScope:'consumption-only'};};return c;});
  });
  afterAll(async()=>ts.close());
  it('uses stored site metadata without probing and refuses cross-tenant access',async()=>{
    ts.adapters.sub2api.calls.length=0;
    expect((await api('/catalog')).json().sites.map((s:{id:number})=>s.id)).toEqual([siteId]);
    expect(ts.adapters.sub2api.calls).toEqual([]);
    expect((await api(`/quality?siteId=${foreignSiteId}&day=${day}`)).statusCode).toBe(404);
    expect((await api('/collect',{siteId:foreignSiteId,day})).statusCode).toBe(404);
    const empty=(await api(`/quality?siteId=${siteId}&day=${day}`)).json();expect(empty.latestEvidenceAt).toBeNull();expect(empty.successRate).toBeNull();expect(empty.groups).toEqual([]);
  });
  it('collects existing records only, deduplicates, and never turns consumption logs into success rate',async()=>{
    expect((await api('/collect',{siteId,day})).json().run.status).toBe('partial');
    expect((await api('/collect',{siteId,day})).json().run.status).toBe('complete');
    const r=(await api(`/quality?siteId=${siteId}&day=${day}`)).json();sourceId=r.records[0].id;
    expect(r.groups[0]).toMatchObject({records:2,recordedCharge:0,observedSupplierCost:2,successRate:null,firstTokenP95Ms:null,flagged:2});
    expect(ts.adapters.sub2api.calls.some(x=>/health|channels.test|channels.update/.test(x))).toBe(false);
    await api('/collect',{siteId,day});await api('/collect',{siteId,day});
    expect((await api(`/quality?siteId=${siteId}&day=${day}`)).json().records).toHaveLength(2);
    expect((await api(`/quality?siteId=${siteId}&day=${day}&requestId=r-1`)).json().records).toHaveLength(1);
  });
  it('withholds complete coverage on repeated pages or changing totals and sanitizes failures',async()=>{
    duplicate=true;await api('/collect',{siteId,day});expect((await api('/collect',{siteId,day})).json().run.status).toBe('changed');
    duplicate=false;await api('/collect',{siteId,day});total=3;expect((await api('/collect',{siteId,day})).json().run.status).toBe('changed');total=2;
    fail=true;const failed=await api('/collect',{siteId,day});expect(failed.statusCode).toBe(502);expect(failed.body).not.toContain('PRIVATE');fail=false;
    await api('/collect',{siteId,day});await api('/collect',{siteId,day});
  });
  it('enforces collection leases and read-only workspace memberships',async()=>{
    await ts.db.orm.update(observationRuns).set({leaseUntil:new Date(Date.now()+60000).toISOString().replace('T',' ').replace('Z','')}).where(eq(observationRuns.siteId,siteId));
    expect((await api('/collect',{siteId,day})).statusCode).toBe(409);
    await ts.db.orm.update(observationRuns).set({leaseUntil:null}).where(eq(observationRuns.siteId,siteId));
    expect((await api('/catalog',undefined,reader.cookie,owner.operatorId)).json().sites).toHaveLength(1);
    expect((await api('/collect',{siteId,day},reader.cookie,owner.operatorId)).statusCode).toBe(403);
    expect((await api('/partners',{siteId,kind:'supplier',name:'Not allowed'},viewer.cookie)).statusCode).toBe(403);
  });
  it('links only same-site evidence, partners and owner tickets',async()=>{
    const p=await api('/partners',{siteId,kind:'supplier',name:'Test supplier'});expect(p.statusCode).toBe(201);partnerId=p.json().item.id;
    const foreign=await api('/partners',{siteId:foreignSiteId,kind:'reseller',name:'Foreign partner'},other.cookie);
    const ticket=(await ts.db.orm.insert(supportTickets).values({operatorId:other.operatorId,subject:'Foreign support'}).returning())[0]!;
    const body={siteId,kind:'incident',title:'Investigate request',description:'Review the existing request evidence',sourceId};
    expect((await api('/work',{...body,partnerId:foreign.json().item.id})).statusCode).toBe(404);
    expect((await api('/work',{...body,ticketId:ticket.id})).statusCode).toBe(404);
    expect((await api('/work',{...body,siteId:foreignSiteId},other.cookie)).statusCode).toBe(404);
    const created=await api('/work',{...body,partnerId});expect(created.statusCode).toBe(201);workId=created.json().item.id;
    expect((await api(`/work/${workId}`,undefined,other.cookie)).statusCode).toBe(404);
  });
  it('keeps case history, rejects concurrent overwrites and requires verification before closing',async()=>{
    expect((await api(`/work/${workId}/events`,{version:1,status:'closed',note:'Do not bypass verification'})).statusCode).toBe(409);
    const update={version:1,status:'investigating',note:'Request logs have been reviewed'};
    expect((await api(`/work/${workId}/events`,update)).statusCode).toBe(200);expect((await api(`/work/${workId}/events`,update)).statusCode).toBe(409);
    expect((await api(`/work/${workId}/events`,{version:2,status:'resolved',note:'Insufficient evidence'})).statusCode).toBe(400);
    expect((await api(`/work/${workId}/events`,{version:2,status:'resolved',note:'All four checks verified in isolated validation',details:{checks:checklists.incident}})).statusCode).toBe(200);
    const result=(await api(`/work/${workId}`)).json();expect(result.events).toHaveLength(3);expect(result.item.evidence.requestId).toBeTruthy();
    expect((await api(`/work/${workId}/export`)).json().financialSettlementProof).toBe('not_verified_by_panel');
  });
  it('requires an actual receipt to complete a settlement and never transfers funds',async()=>{
    const created=await api('/work',{siteId,kind:'settlement',title:'Supplier settlement',description:'Reconcile invoice with existing logs',partnerId});const item=created.json().item;
    await api(`/work/${item.id}/events`,{version:1,status:'investigating',note:'Reconciling supplier statement'});
    const details={checks:checklists.settlement,amount:10,currency:'USD'};
    expect((await api(`/work/${item.id}/events`,{version:2,status:'resolved',note:'Needs real provider receipt',details})).statusCode).toBe(400);
    expect((await api(`/work/${item.id}/events`,{version:2,status:'resolved',note:'Synthetic receipt verified by test only',details:{...details,receipt:'TEST-RECEIPT'}})).statusCode).toBe(200);
  });
  it('public status pages expose only explicitly published text and escape HTML',async()=>{
    const body={siteId,version:0,title:'Public status',body:'Maintenance <script>alert(1)</script>',state:'maintenance',published:false};
    const created=await api('/publication',body);expect(created.statusCode).toBe(200);const p=created.json().item,url='/public/service/'+p.token;
    expect((await ts.app.inject({url})).statusCode).toBe(404);
    expect((await api('/publication',{...body,version:1,published:true})).statusCode).toBe(200);
    const publicPage=await ts.app.inject({url});expect(publicPage.statusCode).toBe(200);expect(publicPage.body).toContain('&lt;script&gt;');expect(publicPage.body).not.toContain('<script>');
    expect(publicPage.body).not.toMatch(/Test supplier|r-1|TEST-RECEIPT/);expect(publicPage.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await api('/publication',{...body,version:1})).statusCode).toBe(409);
    await api('/publication',{...body,version:2,published:false});expect((await ts.app.inject({url})).statusCode).toBe(404);
  });
  it('keeps missing fields unknown, respects free/subscription billing, and makes freshness explicit',()=>{
    expect(signals({...record,billingType:'subscription'})).toEqual([]);expect(signals({...record,expectedCharge:0})).toEqual([]);
    const result=summarize([{...record,durationMs:null,charge:null,supplierCost:null}],Date.parse(record.createdAt)+3600000)[0]!;
    expect(result).toMatchObject({recordedCharge:null,observedSupplierCost:null,durationP95Ms:null,firstTokenP95Ms:null,freshness:'stale',successRate:null});
  });
});
