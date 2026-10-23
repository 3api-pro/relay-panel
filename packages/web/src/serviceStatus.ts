export interface ServiceGroup {
  channelId: string | null; model: string | null; records: number; errorLogs: number | null;
  latestEvidenceAt: string; freshness: string; flagged: number;
}
export interface ServiceReport {
  run: { status: string; updatedAt: string; error: string | null } | null;
  groups: ServiceGroup[]; sourceScope: string; sampleLimited: boolean; latestEvidenceAt: string | null;
}
export interface ServiceWork { kind: string; status: string; priority: string }
export const beijingDay = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export function evidenceTime(value: string | null | undefined): number {
  if (!value) return NaN;
  const iso = value.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : iso + 'Z');
}
const recent = (value: string | null | undefined, now: number) => {
  const age = now - evidenceTime(value);
  return Number.isFinite(age) && age >= -60_000 && age <= 30 * 60_000;
};
export function serviceStatus(input: {
  report: ServiceReport | null; works: ServiceWork[]; siteStatus?: string | undefined;
  loading: boolean; failed: boolean; day: string; now: number;
}) {
  const { report, now } = input;
  const records = report?.groups.reduce((n, g) => n + g.records, 0) ?? 0;
  const flagged = report?.groups.reduce((n, g) => n + g.flagged, 0) ?? 0;
  const affected = report?.groups.filter(g => g.flagged > 0).length ?? 0;
  const pending = input.works.filter(w => ['open', 'investigating', 'waiting'].includes(w.status));
  const metrics = { records, flagged, affected, pending: pending.length, urgent: pending.filter(w => w.priority === 'urgent').length };
  const result = (reason: string, tone: 'red' | 'amber' | 'green' | 'muted', action: 'refresh' | 'collect' | 'signals' | 'work' | 'quality' | 'site') => ({ ...metrics, reason, tone, action });
  if (input.loading) return result('loading', 'muted', 'refresh');
  if (input.failed || !report) return result('unavailable', 'muted', 'refresh');
  if (input.siteStatus !== 'active') return result('inactive', 'amber', 'site');
  if (input.day !== beijingDay(now)) return result('day-changed', 'muted', 'refresh');
  // Positive evidence remains visible even when collection is incomplete or has since failed.
  if (flagged > 0) return result('signals', 'red', 'signals');
  if (pending.some(w => w.kind === 'incident')) return result('incident', 'amber', 'work');
  if (report.run?.status === 'error') return result('collection-error', 'amber', 'collect');
  if (report.run?.status === 'unsupported') return result('unsupported', 'amber', 'site');
  if (report.run?.status === 'changed') return result('changed', 'amber', 'collect');
  if (!report.run || records === 0) return result('empty', 'muted', 'collect');
  if (!recent(report.latestEvidenceAt, now) || !recent(report.run.updatedAt, now)) return result('stale', 'muted', 'collect');
  if (report.run.status !== 'complete') return result('partial', 'amber', 'collect');
  if (report.sampleLimited) return result('limited', 'amber', 'quality');
  if (report.sourceScope !== 'consume-and-error-logs' || report.groups.some(g => g.errorLogs === null)) return result('coverage', 'amber', 'quality');
  if (pending.length) return result('work', 'amber', 'work');
  return result('clear', 'green', 'quality');
}
export function groupStatus(group: ServiceGroup, report: ServiceReport, now: number) {
  if (group.flagged > 0) return { tone: 'red' as const, key: 'signals' };
  if (!recent(group.latestEvidenceAt, now)) return { tone: 'muted' as const, key: 'stale' };
  if (report.run?.status !== 'complete' || report.sampleLimited || report.sourceScope !== 'consume-and-error-logs' || group.errorLogs === null || !recent(report.run.updatedAt, now)) return { tone: 'amber' as const, key: 'limited' };
  return { tone: 'green' as const, key: 'clear' };
}
