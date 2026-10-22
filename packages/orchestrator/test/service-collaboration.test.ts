import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { operators, sites, servicePartners, serviceWork, serviceAccess, serviceAssignments, serviceMessages, organizationMembers, organizations, auditEvents } from '../src/db/schema.js';
import { toPgTimestamp } from '../src/auth/sessions.js';

describe('case-scoped collaboration', () => {
  let ts:TestServer,owner:{operatorId:number;cookie:string},member:typeof owner,other:typeof owner,reader:typeof owner,viewer:typeof owner;
  let siteId:number,foreignSite:number,partnerId:number,workId:number,grantId:number,assignmentId:number,invite:string;
  const base='/api/services/collaboration',portal='/api/collaboration';
  const call=(method:'GET'|'POST'|'DELETE',url:string,payload?:unknown,who=owner,workspace?:number)=>ts.app.inject({method,url,cookies:{rp_session:who.cookie},...(payload?{payload}:{}),...(workspace?{headers:{'x-workspace-id':String(workspace)}}:{})});
  const grant=(email:string,role='support',extra:Record<string,unknown>={})=>call('POST',base+'/access',{siteId,email,role,days:30,...extra});
  const createWork=async(kind:string,extra:Record<string,unknown>={})=>(await ts.db.orm.insert(serviceWork).values({siteId,kind,title:'INTERNAL PRIVATE TITLE',description:'INTERNAL PRIVATE DESCRIPTION',createdBy:owner.operatorId,details:{receipt:'INTERNAL RECEIPT'},...extra}).returning())[0]!;
  beforeAll(async()=>{
    ts=await makeTestServer();
    owner=await ts.seedLogin({email:'collab-owner@example.test',password:'long-test-password',role:'operator'});
    member=await ts.seedLogin({email:'collab-member@example.test',password:'long-test-password',role:'operator'});
    await ts.db.orm.update(operators).set({emailVerifiedAt:null}).where(eq(operators.id,member.operatorId));
    other=await ts.seedLogin({email:'collab-other@example.test',password:'long-test-password',role:'operator'});
    reader=await ts.seedLogin({email:'collab-reader@example.test',password:'long-test-password',role:'operator'});
    viewer=await ts.seedLogin({email:'collab-viewer@example.test',password:'long-test-password',role:'viewer'});
    const data={engine:'sub2api',version:'1',hostPort:0,baseUrl:'http://127.0.0.1:19000',status:'active',managed:'external'};
    siteId=(await ts.db.orm.insert(sites).values({...data,operatorId:owner.operatorId,slug:'collab-own',label:'Private site'}).returning())[0]!.id;
    foreignSite=(await ts.db.orm.insert(sites).values({...data,operatorId:other.operatorId,slug:'collab-other',label:'Other site'}).returning())[0]!.id;
    partnerId=(await ts.db.orm.insert(servicePartners).values({siteId,kind:'supplier',name:'Private supplier',contact:'PRIVATE CONTACT',notes:'PRIVATE PARTNER NOTES'}).returning())[0]!.id;
    workId=(await createWork('incident',{partnerId})).id;
    await ts.db.orm.insert(organizations).values({ownerId:owner.operatorId,name:'Owner workspace'});
    await ts.db.orm.insert(organizationMembers).values({ownerId:owner.operatorId,operatorId:reader.operatorId,role:'editor'});
  });
  afterAll(async()=>ts.close());
  it('permits delegation only by the site owner or root, never editors or viewers',async()=>{
    const body={siteId,email:'someone@example.test',role:'support'};
    expect((await call('POST',base+'/access',body,other)).statusCode).toBe(404);
    expect((await call('POST',base+'/access',body,reader,owner.operatorId)).statusCode).toBe(403);
    expect((await call('POST',base+'/access',body,viewer)).statusCode).toBe(403);
    expect((await call('GET',base+`/access?siteId=${siteId}`,undefined,other)).statusCode).toBe(404);
    expect((await grant('collab-owner@example.test')).statusCode).toBe(400);
    expect((await grant('supplier@example.test','supplier')).statusCode).toBe(400);
    expect((await grant('supplier@example.test','reseller',{partnerId})).statusCode).toBe(400);
  });
  it('stores only hashed invitation tokens, requires verified email and prevents replay',async()=>{
    const r=await grant('COLLAB-MEMBER@example.test','supplier',{partnerId});expect(r.statusCode).toBe(201);
    invite=r.json().token;grantId=r.json().item.id;expect(invite).toMatch(/^[a-f0-9]{64}$/);
    const [stored]=await ts.db.orm.select().from(serviceAccess).where(eq(serviceAccess.id,grantId));expect(stored!.inviteTokenHash).not.toBe(invite);
    expect((await call('GET',base+`/access?siteId=${siteId}`)).body).not.toContain(invite);
    expect((await call('POST',portal+'/accept',{token:invite},member)).statusCode).toBe(403);
    await ts.db.orm.update(operators).set({emailVerifiedAt:toPgTimestamp(new Date())}).where(eq(operators.id,member.operatorId));
    await ts.db.orm.update(operators).set({emailVerifiedAt:toPgTimestamp(new Date())}).where(eq(operators.id,other.operatorId));
    expect((await call('POST',portal+'/accept',{token:invite},other)).statusCode).toBe(400);
    expect((await call('POST',portal+'/accept',{token:invite},member)).statusCode).toBe(200);
    expect((await call('POST',portal+'/accept',{token:invite},member)).statusCode).toBe(400);
    expect((await grant('collab-member@example.test')).statusCode).toBe(409);
    expect(JSON.stringify(await ts.db.orm.select().from(auditEvents))).not.toContain(invite);
  });
  it('does not grant workspace, logs, billing, or site access',async()=>{
    expect((await call('GET','/api/services/catalog',undefined,member)).json().sites).toEqual([]);
    expect((await call('GET','/api/services/catalog',undefined,member,owner.operatorId)).statusCode).toBe(403);
    expect((await call('GET',`/api/services/work/${workId}`,undefined,member)).statusCode).toBe(404);
    expect((await call('GET',base+`/access?siteId=${siteId}`,undefined,member)).statusCode).toBe(404);
    expect((await call('GET',portal+'/assignments',undefined,member)).json().items).toEqual([]);
  });
  it('requires same-site, same-partner and role-appropriate cases',async()=>{
    const share={accessId:grantId,workId,title:'Shared investigation',brief:'Only this reviewed brief is shared'};
    const foreign=(await ts.db.orm.insert(serviceWork).values({siteId:foreignSite,kind:'incident',title:'Foreign case',description:'Foreign description',createdBy:other.operatorId}).returning())[0]!;
    expect((await call('POST',base+'/assignments',{...share,workId:foreign.id})).statusCode).toBe(400);
    const upgrade=await createWork('upgrade',{partnerId});
    expect((await call('POST',base+'/assignments',{...share,workId:upgrade.id})).statusCode).toBe(400);
    const unlinked=await createWork('incident');
    expect((await call('POST',base+'/assignments',{...share,workId:unlinked.id})).statusCode).toBe(400);
    const r=await call('POST',base+'/assignments',share);expect(r.statusCode).toBe(201);assignmentId=r.json().item.id;
    expect((await call('POST',base+'/assignments',share)).statusCode).toBe(409);
  });
  it('returns only shared fields and keeps recipient sessions separate from selected workspaces',async()=>{
    const list=await call('GET',portal+'/assignments',undefined,member,999999);expect(list.statusCode).toBe(200);expect(list.json().items).toHaveLength(1);
    const r=await call('GET',portal+`/assignments/${assignmentId}`,undefined,member);
    expect(r.statusCode).toBe(200);expect(r.body).not.toMatch(/INTERNAL|PRIVATE|Private site|Private supplier|workId|operatorId|partnerId|actorId|tokenHash|baseUrl/);
    expect(Object.keys(r.json().item).sort()).toEqual(['brief','id','kind','revokedAt','role','status','title','updatedAt','version']);
    expect((await call('GET',portal+`/assignments/${assignmentId}`,undefined,other)).statusCode).toBe(404);
  });
  it('serializes concurrent replies and requires owner review after submission',async()=>{
    const url=portal+`/assignments/${assignmentId}/messages`;
    expect((await call('POST',url,{version:1,status:'accepted',body:'Cannot accept own result'},member)).statusCode).toBe(409);
    const replies=await Promise.all([1,2].map(i=>call('POST',url,{version:1,status:'in_progress',body:'Investigating request '+i},member)));
    expect(replies.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect((await call('POST',url,{version:2,status:'submitted',body:'Reviewed logs and submitted result'},member)).statusCode).toBe(200);
    const internal=(await ts.db.orm.select().from(serviceWork).where(eq(serviceWork.id,workId)))[0]!;expect(internal.status).toBe('open');
    expect((await call('POST',base+`/assignments/${assignmentId}/messages`,{version:3,status:'accepted',body:'Owner verified supplied evidence'})).statusCode).toBe(200);
    expect((await call('POST',url,{version:4,status:'submitted',body:'Cannot modify reviewed result'},member)).statusCode).toBe(409);
    expect((await call('POST',base+`/assignments/${assignmentId}/messages`,{version:4,status:'closed',body:'Collaboration has been completed'})).statusCode).toBe(200);
    expect((await call('GET',portal+`/assignments/${assignmentId}`,undefined,member)).json().messages).toHaveLength(5);
  });
  it('enforces support and finance scopes without relying on the UI',async()=>{
    const g=await grant('collab-other@example.test','finance');expect(g.statusCode).toBe(201);
    const id=g.json().item.id;
    const b={accessId:id,workId,title:'Shared financial task',brief:'Financial review scope only'};
    expect((await call('POST',base+'/assignments',b)).statusCode).toBe(400);
    const billing=await createWork('billing_review');
    expect((await call('POST',base+'/assignments',{...b,workId:billing.id})).statusCode).toBe(201);
    await call('DELETE',base+`/access/${id}`);
    const support=await grant('collab-other@example.test','support');
    expect((await call('POST',base+'/assignments',{...b,accessId:support.json().item.id,workId:billing.id})).statusCode).toBe(400);
    await call('DELETE',base+`/access/${support.json().item.id}`);
  });
  it('immediately hides cases for archived partners, expired grants, or disabled owners',async()=>{
    await ts.db.orm.update(servicePartners).set({status:'archived'}).where(eq(servicePartners.id,partnerId));
    expect((await call('GET',portal+'/assignments',undefined,member)).json().items).toEqual([]);
    expect((await call('GET',portal+`/assignments/${assignmentId}`,undefined,member)).statusCode).toBe(404);
    await ts.db.orm.update(servicePartners).set({status:'active'}).where(eq(servicePartners.id,partnerId));
    await ts.db.orm.update(serviceAccess).set({expiresAt:toPgTimestamp(new Date(Date.now()-1000))}).where(eq(serviceAccess.id,grantId));
    expect((await call('GET',portal+`/assignments/${assignmentId}`,undefined,member)).statusCode).toBe(404);
    await ts.db.orm.update(serviceAccess).set({expiresAt:toPgTimestamp(new Date(Date.now()+86400000))}).where(eq(serviceAccess.id,grantId));
    await ts.db.orm.update(operators).set({status:'disabled'}).where(eq(operators.id,owner.operatorId));
    expect((await call('GET',portal+'/assignments',undefined,member)).json().items).toEqual([]);
    await ts.db.orm.update(operators).set({status:'active'}).where(eq(operators.id,owner.operatorId));
  });
  it('retains an internal audit trail after unsharing and revocation',async()=>{
    expect((await call('DELETE',base+`/assignments/${assignmentId}`)).statusCode).toBe(200);
    expect((await call('GET',portal+`/assignments/${assignmentId}`,undefined,member)).statusCode).toBe(404);
    expect((await call('GET',base+`/assignments/${assignmentId}`)).json().active).toBe(false);
    expect((await call('DELETE',base+`/access/${grantId}`)).statusCode).toBe(200);
    expect((await call('DELETE',base+`/access/${grantId}`)).statusCode).toBe(200);
    expect((await call('GET',portal+'/assignments',undefined,member)).json().items).toEqual([]);
    expect((await ts.db.orm.select().from(serviceMessages).where(eq(serviceMessages.assignmentId,assignmentId))).length).toBe(5);
    expect((await call('POST',portal+`/assignments/${assignmentId}/messages`,{version:6,status:'in_progress',body:'Revoked access cannot reply'},member)).statusCode).toBe(404);
    expect((await grant('collab-member@example.test','supplier',{partnerId})).statusCode).toBe(201);
  });
  it('expires unaccepted invites and denies forged fields or cross-origin writes',async()=>{
    const g=await grant('collab-other@example.test');const id=g.json().item.id;
    await ts.db.orm.update(serviceAccess).set({inviteExpiresAt:toPgTimestamp(new Date(Date.now()-1000))}).where(eq(serviceAccess.id,id));
    expect((await call('POST',portal+'/accept',{token:g.json().token},other)).statusCode).toBe(400);
    expect((await call('POST',base+'/assignments',{accessId:id,workId,title:'Shared title',brief:'Reviewed brief',evidence:{secret:'no'}})).statusCode).toBe(400);
    const cross=await ts.app.inject({method:'POST',url:base+'/access',headers:{origin:'https://untrusted.example'},cookies:{rp_session:owner.cookie},payload:{siteId,email:'cross@example.test',role:'support'}});
    expect(cross.statusCode).toBe(403);
    expect((await ts.db.orm.select().from(serviceAssignments)).length).toBe(2);
    expect(ts.adapters.sub2api.calls).toEqual([]);
  });
});
