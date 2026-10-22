import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { makeTestServer, type TestServer } from './helpers.js';
import { JobEngine } from '../src/jobs/engine.js';
import { assertExecutionActive, guardedJobTransaction } from '../src/jobs/execution.js';
import { jobs, sites } from '../src/db/schema.js';
vi.setConfig({testTimeout:30000});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
let ts:TestServer,root:{operatorId:number;cookie:string},owner:typeof root,other:typeof root,viewer:typeof root,siteId:number,seq=0;
const call=(method:'GET'|'POST',path:string,body?:unknown,actor=root)=>ts.app.inject({method,url:'/api/jobs'+path,cookies:{rp_session:actor.cookie},...(body?{payload:body}:{})});
const row=async(id:number)=>(await ts.db.orm.select().from(jobs).where(eq(jobs.id,id)))[0]!;
const uncertain=async(extra={})=>(await ts.db.orm.insert(jobs).values({kind:'upgrade',siteId,slug:'leased-site',createdBy:'lease-root@example.test',status:'uncertain',startedAt:'2020-01-01',heartbeatAt:'2020-01-01',leaseUntil:'2020-01-01',leaseToken:'PRIVATE_EXECUTION_TOKEN',error:'Controlled interrupted execution',...extra}).returning())[0]!;
beforeAll(async()=>{
 ts=await makeTestServer();root=await ts.seedLogin({email:'lease-root@example.test',password:'test-password'});owner=await ts.seedLogin({email:'lease-owner@example.test',password:'test-password',role:'operator'});other=await ts.seedLogin({email:'lease-other@example.test',password:'test-password',role:'operator'});viewer=await ts.seedLogin({email:'lease-viewer@example.test',password:'test-password',role:'viewer'});
 siteId=(await ts.db.orm.insert(sites).values({operatorId:owner.operatorId,slug:'leased-site',label:'Leased site',engine:'sub2api',version:'v1',hostPort:0,managed:'compose',status:'active',baseUrl:'https://example.test'}).returning())[0]!.id;
},60000);
afterEach(async()=>{await ts.db.orm.update(jobs).set({status:'cancelled'}).where(inArray(jobs.status,['queued','running','uncertain']));});
afterAll(async()=>ts.close());
describe('durable lifecycle job ownership',()=>{
 it('serializes concurrent enqueue before either worker can execute',async()=>{
  const a=new JobEngine(ts.db),b=new JobEngine(ts.db);
  const rs=await Promise.allSettled([a.enqueue('start','simultaneous',undefined,'system'),b.enqueue('stop','simultaneous',undefined,'system')]);
  expect(rs.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((rs.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
 });
 it('shares the global two-slot limit and claims each job only once across workers',async()=>{
  const a=new JobEngine(ts.db),b=new JobEngine(ts.db),gate=deferred(),executed:number[]=[];
  for(const engine of [a,b])engine.registerHandler('start',async j=>{executed.push(j.id);await gate.promise;});
  for(let n=0;n<3;n++)await a.enqueue('start',`global-${n}`,undefined,'system');
  try{await Promise.all([a.tick(),b.tick()]);await vi.waitFor(()=>expect(executed).toHaveLength(2));expect(new Set(executed).size).toBe(2);expect(await a.reconcileOrphans()).toBe(0);expect(await b.reconcileOrphans()).toBe(0);}finally{gate.resolve();await Promise.all([a.idle(),b.idle()]);}
  await a.tick();await a.idle();expect(executed).toHaveLength(3);expect(new Set(executed).size).toBe(3);
 });
 it('expired execution retains its fence and cannot resume writes after manual review',async()=>{
  const engine=new JobEngine(ts.db),gate=deferred(),entered=deferred();
  engine.registerHandler('upgrade',async()=>{entered.resolve();await gate.promise;await guardedJobTransaction(ts.db,async orm=>{await orm.update(sites).set({version:'STALE_WORKER'}).where(eq(sites.id,siteId));});});
  const id=await engine.enqueue('upgrade','leased-site',{},'lease-root@example.test',{siteId});await engine.tick();await entered.promise;
  await ts.db.orm.update(jobs).set({leaseUntil:'2020-01-01',heartbeatAt:'2020-01-01'}).where(eq(jobs.id,id));expect(await new JobEngine(ts.db).reconcileOrphans()).toBe(1);
  await expect(engine.enqueue('start','leased-site',undefined,'system',{siteId})).rejects.toMatchObject({statusCode:409});
  const p=await call('GET',`/${id}/review-preview`);expect(p.statusCode,p.body).toBe(200);expect(p.body).not.toContain((await row(id)).leaseToken!);
  const r=await call('POST',`/${id}/resolve`,{confirmation:p.json().confirmation,confirmStopped:true,outcome:'observed-incomplete',note:'Controlled test: old work paused and observed incomplete'});expect(r.statusCode,r.body).toBe(200);
  gate.resolve();await engine.idle();expect((await row(id)).status).toBe('resolved');expect((await ts.db.orm.select().from(sites).where(eq(sites.id,siteId)))[0]!.version).toBe('v1');
 });
 it('retains the reservation when ownership verification or a guarded state commit is unavailable',async()=>{
  for(const failure of ['ownership','state-commit']) {
   const engine=new JobEngine(ts.db);
   engine.registerHandler('start',async()=>{
    if(failure==='ownership') {
     const query=vi.spyOn(ts.db.orm,'select').mockImplementationOnce(()=>{throw new Error('Controlled unavailable database');});
     try { await assertExecutionActive(); } finally { query.mockRestore(); }
    } else {
     await guardedJobTransaction(ts.db,async()=>{throw new Error('Controlled failed state commit after engine action');});
    }
   });
   const slug=`database-failure-${failure}`;
   const id=await engine.enqueue('start',slug,undefined,'system');await engine.tick();await engine.idle();
   expect((await row(id)).status).toBe('uncertain');expect((await row(id)).error).not.toContain('Controlled');
   await expect(engine.enqueue('start',slug,undefined,'system')).rejects.toMatchObject({statusCode:409});
  }
 });
 it('renews only its live lease during a long operation',async()=>{
  const engine=new JobEngine(ts.db),gate=deferred();engine.registerHandler('start',async()=>gate.promise);
  const id=await engine.enqueue('start','renewing',undefined,'system');await engine.tick();const first=await row(id);
  try{await vi.waitFor(async()=>expect((await row(id)).heartbeatAt).not.toBe(first.heartbeatAt),{timeout:14000,interval:100});expect(await new JobEngine(ts.db).reconcileOrphans()).toBe(0);}finally{gate.resolve();await engine.idle();}
  expect((await row(id)).status).toBe('succeeded');
 });
 it('keeps shutdown results uncertain and ignores a late successful handler',async()=>{
  const engine=new JobEngine(ts.db),gate=deferred();engine.registerHandler('start',async()=>gate.promise);const id=await engine.enqueue('start','shutdown',undefined,'system');await engine.tick();
  const stopping=engine.shutdown();await vi.waitFor(async()=>expect((await row(id)).status).toBe('uncertain'));gate.resolve();await stopping;expect((await row(id)).status).toBe('uncertain');
 });
 it('requires a fresh aged preview and root review with explicit stopped-process acknowledgement',async()=>{
  const j=await uncertain({heartbeatAt:new Date().toISOString()});
  expect((await call('GET',`/${j.id}/review-preview`,undefined,owner)).statusCode).toBe(403);
  let p=(await call('GET',`/${j.id}/review-preview`)).json();expect(p.eligible).toBe(false);
  const body=()=>({confirmation:p.confirmation,confirmStopped:true,outcome:'observed-incomplete',note:'Verified host state and stopped old executor'});
  expect((await call('POST',`/${j.id}/resolve`,body())).statusCode).toBe(409);
  await ts.db.orm.update(jobs).set({heartbeatAt:'2020-01-01'}).where(eq(jobs.id,j.id));p=(await call('GET',`/${j.id}/review-preview`)).json();
  expect((await call('POST',`/${j.id}/resolve`,{...body(),confirmStopped:false})).statusCode).toBe(400);
  await ts.db.orm.update(sites).set({version:'v2'}).where(eq(sites.id,siteId));expect((await call('POST',`/${j.id}/resolve`,body())).statusCode).toBe(409);
  p=(await call('GET',`/${j.id}/review-preview`)).json();expect((await call('POST',`/${j.id}/resolve`,body())).statusCode).toBe(200);
  expect((await row(j.id)).reviewNote).toContain('Verified host');expect((await row(j.id)).status).toBe('resolved');await ts.db.orm.update(sites).set({version:'v1'}).where(eq(sites.id,siteId));
 });
 it('rolls back manual release when audit cannot be written',async()=>{
  const j=await uncertain(),p=(await call('GET',`/${j.id}/review-preview`)).json();
  await ts.db.exec("CREATE FUNCTION fail_job_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='job.resolved' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_job_audit_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_job_audit();");
  try{expect((await call('POST',`/${j.id}/resolve`,{confirmation:p.confirmation,confirmStopped:true,outcome:'observed-complete',note:'Controlled manual verification completed'})).statusCode).toBe(500);}finally{await ts.db.exec('DROP TRIGGER fail_job_audit_trigger ON audit_events; DROP FUNCTION fail_job_audit();');}
  expect((await row(j.id)).status).toBe('uncertain');expect((await row(j.id)).reviewedAt).toBeNull();
 });
 it('only cancels queued owner jobs and preserves tenant boundaries',async()=>{
  const id=await ts.jobs.enqueue('start','leased-site',undefined,'lease-owner@example.test',{siteId});
  expect((await call('POST',`/${id}/cancel`,{confirm:true},other)).statusCode).toBe(404);expect((await call('POST',`/${id}/cancel`,{confirm:true},viewer)).statusCode).toBe(403);
  expect((await call('POST',`/${id}/cancel`,{confirm:true},owner)).statusCode).toBe(200);expect(await ts.jobs.tick()).toBe(0);
  const j=await uncertain();expect((await call('POST',`/${j.id}/cancel`,{confirm:true})).statusCode).toBe(409);
 });
 it('refuses readonly lifecycle submission and rechecks readonly after queueing',async()=>{
  await ts.db.orm.update(sites).set({readonly:true}).where(eq(sites.id,siteId));
  const r=await ts.app.inject({method:'POST',url:'/api/sites/leased-site/start',cookies:{rp_session:root.cookie}});expect(r.statusCode).toBe(403);
  await ts.db.orm.update(sites).set({readonly:false}).where(eq(sites.id,siteId));
  const id=await ts.jobs.enqueue('start','leased-site',undefined,'lease-root@example.test',{siteId});await ts.db.orm.update(sites).set({readonly:true}).where(eq(sites.id,siteId));
  const before=ts.lifecycles.sub2api.calls.length;await ts.jobs.tick();await ts.jobs.idle();expect((await row(id)).status).toBe('failed');expect(ts.lifecycles.sub2api.calls).toHaveLength(before);
  await ts.db.orm.update(sites).set({readonly:false}).where(eq(sites.id,siteId));
 });
 it('filters and pages old tasks without exposing execution tokens',async()=>{
  for(let n=0;n<3;n++)await uncertain({slug:`private-history-${++seq}`});
  const first=await call('GET','?status=uncertain&limit=2');expect(first.statusCode).toBe(200);expect(first.json().hasMore).toBe(true);expect(first.body).not.toMatch(/leaseToken|PRIVATE_EXECUTION_TOKEN/);
  const next=await call('GET',`?status=uncertain&limit=2&beforeId=${first.json().jobs.at(-1).id}`);expect(next.json().jobs).toHaveLength(1);expect(next.json().hasMore).toBe(false);
  expect((await call('GET','?status=invalid')).statusCode).toBe(400);
 });
});
