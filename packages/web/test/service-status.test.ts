import { describe, expect, it } from 'vitest';
import { beijingDay, evidenceTime, groupStatus, serviceStatus, type ServiceReport } from '../src/serviceStatus';
const now = Date.parse('2026-10-23T04:00:00Z');
function report(): ServiceReport {
  return { run: {status:'complete',updatedAt:'2026-10-23 03:59:00',error:null}, sourceScope:'consume-and-error-logs',sampleLimited:false,latestEvidenceAt:'2026-10-23T03:58:00Z',groups:[{channelId:'1',model:'model',records:250,errorLogs:0,latestEvidenceAt:'2026-10-23T03:58:00Z',freshness:'recent',flagged:0}] };
}
const assess = (r: ServiceReport | null, extra: Partial<Parameters<typeof serviceStatus>[0]> = {}) => serviceStatus({report:r,works:[],siteStatus:'active',loading:false,failed:false,day:beijingDay(now),now,...extra});
describe('honest passive service status', () => {
  it('shows no issues for recent observed evidence', () => {
    expect(assess(report())).toMatchObject({reason:'clear',tone:'green',records:250});
  });
  it.each(['error','unsupported','pending'])('never calls a %s collection healthy', status => {
    const r=report();r.run!.status=status;expect(assess(r).tone).not.toBe('green');
  });
  it('keeps evidence scope separate from alerts and preserves the no-data state', () => {
    const r=report();r.sourceScope='consumption-only';r.groups[0]!.errorLogs=null;
    expect(assess(r)).toMatchObject({reason:'clear',tone:'green'});
    r.groups=[];r.latestEvidenceAt=null;expect(assess(r).reason).toBe('empty');
    const capped=report();capped.sampleLimited=true;expect(assess(capped).reason).toBe('clear');
    expect(assess(null).tone).not.toBe('green');
  });
  it.each(['complete','partial','changed'])('does not warn merely because %s logs only cover consumption', status => {
    const r=report();r.run!.status=status;r.sourceScope='consumption-only';r.groups[0]!.errorLogs=null;r.sampleLimited=true;
    expect(assess(r)).toMatchObject({reason:'clear',tone:'green'});
    expect(groupStatus(r.groups[0]!,r,now)).toMatchObject({key:'clear',tone:'green'});
    r.groups[0]!.flagged=1;expect(assess(r)).toMatchObject({reason:'signals',tone:'red'});
  });
  it('uses group aggregates rather than a truncated request list and keeps issues visible after collection fails', () => {
    const r=report();r.run!.status='error';r.groups[0]!.flagged=230;
    expect(assess(r)).toMatchObject({reason:'signals',tone:'red',flagged:230,affected:1,action:'signals'});
  });
  it('expires a positive result when evidence or collection is old, and at the Beijing day boundary', () => {
    expect(assess(report(),{now:now+31*60000})).toMatchObject({reason:'stale',tone:'muted'});
    const r=report();r.run!.updatedAt='2026-10-23 02:00:00';expect(assess(r).reason).toBe('stale');
    expect(assess(report(),{now:Date.parse('2026-10-23T16:01:00Z')})).toMatchObject({reason:'day-changed',tone:'muted'});
    expect(evidenceTime('2026-10-23 03:59:00')).toBe(Date.parse('2026-10-23T03:59:00Z'));
  });
  it('never keeps a healthy badge after refresh failure or while changing sites', () => {
    expect(assess(report(),{failed:true}).reason).toBe('unavailable');
    expect(assess(report(),{loading:true}).reason).toBe('loading');
    expect(assess(report(),{siteStatus:'failed:compose-up'}).reason).toBe('inactive');
  });
  it('distinguishes work awaiting follow-up from observed request errors', () => {
    const works=[{kind:'incident',status:'waiting',priority:'urgent'},{kind:'incident',status:'resolved',priority:'urgent'},{kind:'quote',status:'open',priority:'normal'}];
    expect(assess(report(),{works})).toMatchObject({reason:'incident',tone:'amber',pending:2,urgent:1,action:'work'});
    expect(assess(report(),{works:works.slice(1)}).reason).toBe('work');
  });
  it('keeps stale channel rows separate from current unflagged or flagged rows', () => {
    const r=report(),g=r.groups[0]!;
    expect(groupStatus(g,r,now)).toMatchObject({key:'clear',tone:'green'});
    g.latestEvidenceAt='2026-10-23T01:00:00Z';expect(groupStatus(g,r,now).key).toBe('stale');
    g.flagged=1;expect(groupStatus(g,r,now).key).toBe('signals');
    g.flagged=0;g.latestEvidenceAt=r.latestEvidenceAt!;r.sourceScope='consumption-only';expect(groupStatus(g,r,now).key).toBe('clear');
  });
});
