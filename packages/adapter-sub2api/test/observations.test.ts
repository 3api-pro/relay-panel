import { describe,it,expect,vi } from 'vitest';
import { observations,normalizeObservation } from '../src/observations.js';
import { Sub2apiHttp } from '../src/http.js';
const raw={id:1,request_id:'req-1',created_at:'2026-10-21T04:00:00Z',account_id:3,model:'model',duration_ms:1234,first_token_ms:250,actual_cost:0,total_cost:2,rate_multiplier:1,billing_type:0,input_tokens:10,output_tokens:5,api_key:{key:'PRIVATE'},user:{email:'PRIVATE'},ip_address:'PRIVATE'};
describe('Sub2API passive evidence',()=>{
  it('keeps only allowlisted fields and does not claim request success',()=>{const r=normalizeObservation(raw);expect(r).toMatchObject({channelId:'3',outcome:'consumption',durationMs:1234,firstTokenMs:250,charge:0,expectedCharge:2});expect(JSON.stringify(r)).not.toContain('PRIVATE');expect(normalizeObservation({...raw,duration_ms:-1,first_token_ms:undefined}).durationMs).toBeNull();});
  it('reads only the bounded usage GET and rejects invalid pagination/ranges',async()=>{const http=new Sub2apiHttp('https://unused.invalid',null),get=vi.spyOn(http,'get').mockResolvedValue({items:[raw],total:1,pages:1,page:1,page_size:100});
    const p=await observations(http,{day:'2026-10-21',page:1});expect(p.sourceIds).toEqual(['1']);expect(get.mock.calls[0]![0]).toMatch(/^\/api\/v1\/admin\/usage\?/);
    await expect(observations(http,{day:'2026-10-20',page:1})).rejects.toThrow('range');await expect(observations(http,{day:'2026-10-21',page:2})).rejects.toThrow('pagination');});
});
