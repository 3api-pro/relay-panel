import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from './helpers.js';
import type { Db } from '../src/db/client.js';
import { jobs } from '../src/db/schema.js';
import { executionScope } from '../src/jobs/execution.js';
const driver=vi.hoisted(()=>({mode:'success',calls:[] as {timeout:number;signal?:AbortSignal}[]}));
vi.mock('node:child_process',()=>({execFile:(_command:string,_args:string[],options:{timeout:number;signal?:AbortSignal},callback:(e:Error|null,stdout?:{stdout:string})=>void)=>{
 driver.calls.push(options);
 if(driver.mode==='fail')queueMicrotask(()=>callback(new Error('postgres://user:PRIVATE_PASSWORD@host PRIVATE_STDERR')));
 else if(driver.mode==='hold')options.signal!.addEventListener('abort',()=>callback(Object.assign(new Error('aborted'),{code:'ABORT_ERR'})),{once:true});
 else queueMicrotask(()=>callback(null,{stdout:'controlled-output'}));
}}));
import { dockerCompose } from '../src/provision/docker.js';
let db:Db;
beforeAll(async()=>{db=await makeTestDb();},60000);afterAll(async()=>db.close());beforeEach(()=>{driver.mode='success';driver.calls=[];});
const ref={project:'isolated-project',file:'/controlled/compose.yml',envFile:'/controlled/.env'};
describe('bounded Docker command execution',()=>{
 it('applies a finite command deadline and keeps raw engine output out of errors',async()=>{
  expect(await dockerCompose.start(ref)).toBe('controlled-output');expect(driver.calls[0]!.timeout).toBe(600000);
  driver.mode='fail';await expect(dockerCompose.start(ref)).rejects.toThrow('inspect private host logs');await expect(dockerCompose.start(ref)).rejects.not.toThrow('PRIVATE');
 });
 it('refuses to spawn a command with an expired job lease',async()=>{
  const [j]=await db.orm.insert(jobs).values({kind:'start',slug:'expired-driver',createdBy:'system',status:'running',leaseToken:'controlled-token',leaseUntil:'2020-01-01'}).returning();
  await expect(executionScope.run({db,jobId:j!.id,token:'controlled-token',controller:new AbortController()},()=>dockerCompose.start(ref))).rejects.toThrow('执行权');expect(driver.calls).toHaveLength(0);
 });
 it('propagates worker cancellation to the child process and retains uncertainty',async()=>{
  const [j]=await db.orm.insert(jobs).values({kind:'start',slug:'aborted-driver',createdBy:'system',status:'running',leaseToken:'controlled-token',leaseUntil:'2099-01-01'}).returning();
  const controller=new AbortController();driver.mode='hold';
  const running=executionScope.run({db,jobId:j!.id,token:'controlled-token',controller},()=>dockerCompose.start(ref));
  await vi.waitFor(()=>expect(driver.calls).toHaveLength(1));controller.abort();await expect(running).rejects.toThrow('执行权');expect(driver.calls[0]!.signal?.aborted).toBe(true);
 });
});
