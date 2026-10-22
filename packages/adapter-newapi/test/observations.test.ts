import {describe,it,expect,vi} from 'vitest';
import {normalizeObservation,observations} from '../src/observations.js';
import {NewapiHttp} from '../src/http.js';
const raw={id:20,request_id:'req-20',created_at:Date.parse('2026-10-21T04:00:00Z')/1000,type:2,model_name:'m',channel:7,quota:500000,use_time:2,prompt_tokens:1,completion_tokens:2,content:'PRIVATE',other:'PRIVATE',ip:'PRIVATE'};
describe('New API passive log evidence',()=>{
  it('excludes non-request logs and leaves unavailable cost/timing unknown',()=>{expect(normalizeObservation({...raw,type:1})).toBeNull();const r=normalizeObservation(raw)!;expect(r).toMatchObject({charge:1,supplierCost:null,durationMs:2000,firstTokenMs:null,outcome:'consumption'});expect(JSON.stringify(r)).not.toContain('PRIVATE');expect(normalizeObservation({...raw,type:5})!.charge).toBeNull();});
  it('uses stable request identity when numeric IDs change and distinguishes error/consume logs',()=>{expect(normalizeObservation(raw)!.id).toBe(normalizeObservation({...raw,id:1})!.id);expect(normalizeObservation({...raw,type:5})!.id).not.toBe(normalizeObservation(raw)!.id);});
  it('reads admin logs only with exact Beijing boundaries and tracks excluded source rows',async()=>{const http=new NewapiHttp('https://unused.invalid',null);const get=vi.spyOn(http,'get').mockResolvedValue({items:[raw,{...raw,id:21,request_id:'topup',type:1}],page:1,page_size:100,total:2});
    const r=await observations(http,{day:'2026-10-21',page:1});expect(r.items).toHaveLength(1);expect(r.sourceIds).toHaveLength(2);
    const url=new URL(get.mock.calls[0]![0],'https://unused.invalid');expect(url.pathname).toBe('/api/log/');expect(Number(url.searchParams.get('end_timestamp'))-Number(url.searchParams.get('start_timestamp'))).toBe(86399);
    await expect(observations(http,{day:'2026-10-20',page:1})).rejects.toThrow('range');});
});
