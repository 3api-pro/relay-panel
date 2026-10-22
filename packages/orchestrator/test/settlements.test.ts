import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { sites, servicePartners, serviceAccess, operators, financeScopes, financeSubmissions, settlementStatements, settlementReceipts, organizations, organizationMembers } from '../src/db/schema.js';
import { decimal, micros, money } from '../src/settlements/domain.js';
vi.setConfig({ testTimeout: 30000 });
type Login = {operatorId:number;cookie:string};
const base='/api/services/settlements',portal='/api/collaboration/settlements';
describe('partner settlement statements',()=>{
 let ts:TestServer,owner:Login,member:Login,finance:Login,other:Login,siteId:number,partnerId:number,accessId:number,financeAccess:number,seq=0;
 const call=(method:'GET'|'POST'|'DELETE',url:string,payload?:unknown,actor=owner,workspace?:number)=>ts.app.inject({method,url,cookies:{rp_session:actor.cookie},...(workspace?{headers:{'x-workspace-id':String(workspace)}}:{}),...(payload===undefined?{}:{payload})});
 const body=(extra:Record<string,unknown>={})=>({siteId,partnerId,reference:`INV-${++seq}`,title:'Supplier October invoice',direction:'payable',currency:'USD',fromDay:'2026-10-01',toDay:'2026-10-02',dueDay:'2026-10-10',lines:[{label:'Usage',amount:'0.100000'},{label:'Service',amount:'0.200000'},{label:'Credit',amount:'-0.050000'}],publicNote:'Agreed billing period',internalNote:'PRIVATE_OWNER_NOTE',sourceReviewId:null,version:0,...extra});
 const create=async(extra:Record<string,unknown>={})=>{const b=body(extra),r=await call('POST',base,b);expect(r.statusCode,r.body).toBe(201);return{...r.json().item,input:b};};
 const read=async(id:number)=>{const r=await call('GET',`${base}/${id}`);expect(r.statusCode,r.body).toBe(200);return r.json();};
 const issue=async(id:number)=>{const s=(await read(id)).item;const r=await call('POST',`${base}/${id}/issue`,{version:s.version,acknowledge:true});expect(r.statusCode,r.body).toBe(200);return r.json().item;};
 const shareTo=async(id:number,grant=accessId)=>{const p=await call('POST',`${base}/${id}/share-preview`,{accessId:grant});expect(p.statusCode,p.body).toBe(200);const r=await call('POST',`${base}/${id}/shares`,{accessId:grant,confirmation:p.json().confirmation,acknowledge:true});expect(r.statusCode,r.body).toBe(201);return r.json().item;};
 const receipt=async(id:number,amount:string,reference=`PAY-${++seq}`,extra={})=>call('POST',`${base}/${id}/receipts`,{version:(await read(id)).item.version,amount,reference,method:'Bank transfer',receivedDay:'2026-10-02',note:'Public receipt note',acknowledge:true,...extra});
 beforeAll(async()=>{
  ts=await makeTestServer();owner=await ts.seedLogin({email:'settlement-owner@example.test',password:'test-password',role:'operator'});member=await ts.seedLogin({email:'settlement-supplier@example.test',password:'test-password',role:'operator'});finance=await ts.seedLogin({email:'settlement-finance@example.test',password:'test-password',role:'operator'});other=await ts.seedLogin({email:'settlement-other@example.test',password:'test-password',role:'operator'});
  siteId=(await ts.db.orm.insert(sites).values({operatorId:owner.operatorId,slug:'settlement-site',label:'PRIVATE_SITE_NAME',engine:'sub2api',version:'v1',baseUrl:'https://private-engine.example',hostPort:0,managed:'external',status:'active'}).returning())[0]!.id;
  partnerId=(await ts.db.orm.insert(servicePartners).values({siteId,kind:'supplier',name:'Supplier A',contact:'PRIVATE_CONTACT'}).returning())[0]!.id;
  for(const [who,role,p] of [[member,'supplier',partnerId],[finance,'finance',undefined]] as const){const r=await call('POST','/api/services/collaboration/access',{siteId,email:who===member?'settlement-supplier@example.test':'settlement-finance@example.test',role,partnerId:p});expect(r.statusCode,r.body).toBe(201);expect((await call('POST','/api/collaboration/accept',{token:r.json().token},who)).statusCode).toBe(200);if(who===member)accessId=r.json().item.id;else financeAccess=r.json().item.id;}
 },60000);
 afterAll(async()=>ts.close());
 it('uses exact signed six-decimal amounts and rejects malformed or unbounded values',async()=>{
  expect(decimal(micros('0.1')+micros('0.2')-micros('0.05'))).toBe('0.250000');
  for(const v of ['NaN','1e6','0.0000001','1000000001','01.2','', '1.2.3'])expect(money.safeParse(v).success).toBe(false);
  for(const amount of ['NaN','0','-1','0.0000001'])expect((await call('POST',base,body({lines:[{label:'Bad',amount}]}))).statusCode).toBe(400);
  const s=await create();expect(s.total).toBe('0.250000');
 });
 it('keeps drafts private, enforces tenant ownership, and freezes issued content',async()=>{
  const s=await create();expect((await call('GET',portal,undefined,member)).json().items).toEqual([]);
  expect((await call('GET',`${base}/${s.id}`,undefined,other)).statusCode).toBe(404);
  expect((await call('POST',`${base}/${s.id}/share-preview`,{accessId})).statusCode).toBe(409);
  const edit=await call('POST',`${base}/${s.id}`,{...s.input,version:s.version,title:'Corrected invoice'});expect(edit.statusCode).toBe(200);
  expect((await call('POST',`${base}/${s.id}`,{...s.input,version:s.version})).statusCode).toBe(409);
  await issue(s.id);expect((await call('POST',`${base}/${s.id}`,{...s.input,version:(await read(s.id)).item.version})).statusCode).toBe(409);
  expect((await call('POST',base,s.input)).statusCode).toBe(409);
 });
 it('requires a current sharing preview and never shares private source fields',async()=>{
  const s=await create();await issue(s.id);const p=await call('POST',`${base}/${s.id}/share-preview`,{accessId});
  expect(p.body).not.toMatch(/PRIVATE_|sourceEvidence|sourceReviewId|ownerId|createdBy|baseUrl|siteId/);
  expect((await receipt(s.id,'0.050000')).statusCode).toBe(201);
  expect((await call('POST',`${base}/${s.id}/shares`,{accessId,confirmation:p.json().confirmation,acknowledge:true})).statusCode).toBe(409);
  const share=await shareTo(s.id);const r=await call('GET',`${portal}/${share.id}`,undefined,member,999999);
  expect(r.statusCode).toBe(200);expect(r.body).not.toMatch(/PRIVATE_|internal|sourceReview|siteId|ownerId|baseUrl|actorId/);expect(r.json().balance.recorded).toBe('0.050000');
  expect((await call('GET',`${portal}/${share.id}`,undefined,other)).statusCode).toBe(404);
  expect((await call('GET',`${portal}/${share.id}/receipts`,undefined,member)).body).not.toMatch(/ownerId|recordedBy|statementId/);
 });
 it('keeps each collaborator response separate and does not treat agreement as payment',async()=>{
  const s=await create();await issue(s.id);const a=await shareTo(s.id),b=await shareTo(s.id,financeAccess);
  const r=await call('POST',`${portal}/${a.id}/respond`,{version:a.version,status:'disputed',note:'SUPPLIER_PRIVATE_RESPONSE'},member);expect(r.statusCode).toBe(200);
  expect((await call('POST',`${portal}/${a.id}/respond`,{version:a.version,status:'acknowledged',note:'Old version reply'},member)).statusCode).toBe(409);
  expect((await call('GET',`${portal}/${b.id}/events`,undefined,finance)).body).not.toContain('SUPPLIER_PRIVATE_RESPONSE');
  expect((await call('GET',`${base}/${s.id}/events`)).body).toContain('SUPPLIER_PRIVATE_RESPONSE');
  expect((await read(s.id)).balance.status).toBe('unrecorded');
 });
 it('records partial and full receipts exactly, rejects duplicates, future dates and overpayment',async()=>{
  const s=await create();await issue(s.id);const ref=`PAY-unique-${++seq}`;
  for(const amount of ['NaN','1e6','','1.2.3','0','-1','0.0000001'])expect((await receipt(s.id,amount)).statusCode).toBe(400);
  expect((await receipt(s.id,'0.1',ref)).statusCode).toBe(201);expect((await read(s.id)).balance).toMatchObject({recorded:'0.100000',remaining:'0.150000',status:'partially_recorded',proof:'operator-recorded'});
  expect((await receipt(s.id,'0.01',ref)).statusCode).toBe(409);expect((await receipt(s.id,'0.150001')).statusCode).toBe(400);
  expect((await receipt(s.id,'0.01',undefined,{receivedDay:'2099-01-01'})).statusCode).toBe(400);
  const otherBill=await create();await issue(otherBill.id);expect((await receipt(otherBill.id,'0.1',ref)).statusCode).toBe(409);
  expect((await receipt(s.id,'0.15')).statusCode).toBe(201);expect((await read(s.id)).balance).toMatchObject({remaining:'0.000000',status:'recorded_in_full'});
 });
 it('voids preserve original evidence, recalculate totals and allow correcting the same receipt reference',async()=>{
  const s=await create();await issue(s.id);const ref=`PAY-correct-${++seq}`,r=await receipt(s.id,'0.1',ref);
  expect((await call('POST',`${base}/${s.id}/cancel`,{version:(await read(s.id)).item.version,reason:'Cancel outstanding invoice'})).statusCode).toBe(409);
  expect((await call('POST',`${base}/${s.id}/receipts/${r.json().item.id}/void`,{version:(await read(s.id)).item.version,reason:'Recorded the wrong amount'})).statusCode).toBe(200);
  expect((await read(s.id)).balance.recorded).toBe('0.000000');expect((await receipt(s.id,'0.08',ref)).statusCode).toBe(201);
  const rows=(await call('GET',`${base}/${s.id}/receipts`)).json().items;expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({amount:'0.100000',voidReason:'Recorded the wrong amount'});
 });
 it('serializes simultaneous receipt submissions and rejects a stale financial revision',async()=>{
  const s=await create();const issued=await issue(s.id);const b={version:issued.version,amount:'0.2',method:'Bank transfer',receivedDay:'2026-10-02',note:'Concurrent receipt',acknowledge:true};
  const rs=await Promise.all([1,2].map(n=>call('POST',`${base}/${s.id}/receipts`,{...b,reference:`CONCURRENT-${s.id}-${n}`})));expect(rs.map(r=>r.statusCode).sort()).toEqual([201,409]);expect((await read(s.id)).balance.recorded).toBe('0.200000');
 });
 it('revocation, expiry, verification and partner archive revoke shared reads, exports and responses',async()=>{
  const s=await create();await issue(s.id);let a=await shareTo(s.id);
  await ts.db.orm.update(operators).set({emailVerifiedAt:null}).where(eq(operators.id,member.operatorId));expect((await call('GET',`${portal}/${a.id}`,undefined,member)).statusCode).toBe(403);await ts.db.orm.update(operators).set({emailVerifiedAt:new Date().toISOString()}).where(eq(operators.id,member.operatorId));
  await ts.db.orm.update(servicePartners).set({status:'archived'}).where(eq(servicePartners.id,partnerId));expect((await call('GET',`${portal}/${a.id}/export.csv`,undefined,member)).statusCode).toBe(404);await ts.db.orm.update(servicePartners).set({status:'active'}).where(eq(servicePartners.id,partnerId));
  expect((await call('DELETE',`${base}/${s.id}/shares/${a.id}`)).statusCode).toBe(200);expect((await call('GET',`${portal}/${a.id}`,undefined,member)).statusCode).toBe(404);
  a=await shareTo(s.id);const [grant]=await ts.db.orm.select().from(serviceAccess).where(eq(serviceAccess.id,accessId));await ts.db.orm.update(serviceAccess).set({expiresAt:'2001-01-01'}).where(eq(serviceAccess.id,accessId));expect((await call('POST',`${portal}/${a.id}/respond`,{version:1,status:'acknowledged',note:'Cannot bypass expiry'},member)).statusCode).toBe(404);await ts.db.orm.update(serviceAccess).set({expiresAt:grant!.expiresAt}).where(eq(serviceAccess.id,accessId));
 });
 it('imports accepted same-site finance evidence privately and prevents duplicate source statements',async()=>{
  await ts.db.orm.insert(financeScopes).values({accessId:financeAccess,label:'Private cost scope',fromDay:'2026-10-01',toDay:'2026-10-02',costs:true,version:1});
  const report={scope:{accessId:financeAccess,label:'PRIVATE_SCOPE',fromDay:'2026-10-01',toDay:'2026-10-02',channelId:'PRIVATE_CHANNEL',model:null,costs:true,details:false,export:false,review:true,enabled:true,version:1},currency:'USD' as const,timezone:'Asia/Shanghai' as const,generatedAt:new Date().toISOString(),days:[{day:'2026-10-01',scanStatus:'partial',sourceScope:'consumption-only',collectedAt:null,records:2,pricedRecords:2,chargeUsd:'0.500000',costRecords:1,supplierCostUsd:'0.300000'}],records:2,pricedRecords:2,chargeUsd:'0.500000',costRecords:1,supplierCostUsd:'0.300000'};
  const [source]=await ts.db.orm.insert(financeSubmissions).values({accessId:financeAccess,scopeVersion:1,report,note:'Private review',status:'accepted'}).returning();
  expect((await call('GET',`${base}/sources/${source!.id}`,undefined,other)).statusCode).toBe(404);
  expect((await call('POST',base,body({sourceReviewId:source!.id,currency:'CNY'}))).statusCode).toBe(400);
  const s=await create({sourceReviewId:source!.id});expect((await read(s.id)).internal.sourceEvidence.records).toBe(2);
  expect((await call('POST',base,body({sourceReviewId:source!.id}))).statusCode).toBe(409);
  await issue(s.id);const shared=await shareTo(s.id);expect((await call('GET',`${portal}/${shared.id}`,undefined,member)).body).not.toMatch(/PRIVATE_|sourceEvidence|sourceReviewId|costRecords|channelId/);
 });
 it('export escapes formulas and excludes internal evidence; cancellation never calls adapters',async()=>{
  const s=await create({publicNote:'=HYPERLINK("malicious")',lines:[{label:'+Formula line',amount:'1'}]});await issue(s.id);const a=await shareTo(s.id);
  const csv=await call('GET',`${portal}/${a.id}/export.csv`,undefined,member);expect(csv.statusCode).toBe(200);expect(csv.body).toContain("'+Formula line");expect(csv.body).not.toMatch(/PRIVATE_|sourceEvidence|ownerId/);
  expect((await call('POST',`${base}/${s.id}/cancel`,{version:(await read(s.id)).item.version,reason:'Agreed to cancel this statement'})).statusCode).toBe(200);
  expect((await call('GET',`${portal}/${a.id}`,undefined,member)).json().item.status).toBe('cancelled');expect((await call('POST',`${portal}/${a.id}/respond`,{version:a.version,status:'acknowledged',note:'After cancellation'},member)).statusCode).toBe(409);
  expect(ts.adapters.sub2api.calls).toEqual([]);expect(ts.adapters.newapi.calls).toEqual([]);
 });
 it('team editors cannot issue or create statements on behalf of the owner',async()=>{
  await ts.db.orm.insert(organizations).values({ownerId:owner.operatorId,name:'Workspace'});await ts.db.orm.insert(organizationMembers).values({ownerId:owner.operatorId,operatorId:other.operatorId,role:'editor'});
  expect((await call('POST',base,body(),other,owner.operatorId)).statusCode).toBe(403);
  const s=await create();expect((await call('POST',`${base}/${s.id}/issue`,{version:1,acknowledge:true},other,owner.operatorId)).statusCode).toBe(403);
 });
 it('rejects sharing with another partner and never gives recipients receipt-writing authority',async()=>{
  const [partner]=await ts.db.orm.insert(servicePartners).values({siteId,kind:'supplier',name:'Supplier B'}).returning();
  const wrong=await create({partnerId:partner!.id});await issue(wrong.id);
  expect((await call('POST',`${base}/${wrong.id}/share-preview`,{accessId})).statusCode).toBe(404);
  const s=await create({currency:'CNY',direction:'receivable',lines:[{label:'Exact amount',amount:'1.000001'}]});await issue(s.id);await shareTo(s.id);
  expect((await call('POST',`${base}/${s.id}/receipts`,{version:(await read(s.id)).item.version,amount:'0.01',reference:'NOT-AUTHORIZED',method:'Bank transfer',receivedDay:'2026-10-02',note:'Not allowed',acknowledge:true},member)).statusCode).toBe(404);
  expect((await receipt(s.id,'0.010001')).statusCode).toBe(201);expect((await read(s.id)).balance.remaining).toBe('0.990000');
 });
 it('rolls back receipt, version and balance if the financial event cannot be persisted',async()=>{
  const s=await create();const issued=await issue(s.id);
  await ts.db.exec("CREATE FUNCTION settlement_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='receipt.recorded' THEN RAISE EXCEPTION 'test journal failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER settlement_test_trigger BEFORE INSERT ON settlement_events FOR EACH ROW EXECUTE FUNCTION settlement_test_failure();");
  try{expect((await receipt(s.id,'0.1')).statusCode).toBe(500);}finally{await ts.db.exec('DROP TRIGGER settlement_test_trigger ON settlement_events; DROP FUNCTION settlement_test_failure();');}
  const current=await read(s.id);expect(current.item.version).toBe(issued.version);expect(current.balance.recorded).toBe('0.000000');expect((await call('GET',`${base}/${s.id}/receipts`)).json().items).toEqual([]);
 });
});
