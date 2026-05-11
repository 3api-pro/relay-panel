import { ReactNode } from 'react';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: 'up' | 'down' | null;
  trendValue?: string;
}

export function StatCard({ label, value, hint, trend, trendValue }: Props) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-5 py-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-slate-900 mt-1.5 leading-tight">{value}</div>
      <div className="mt-1 text-xs flex items-center gap-2">
        {trend === 'up' && <span className="text-emerald-600">↑ {trendValue}</span>}
        {trend === 'down' && <span className="text-rose-600">↓ {trendValue}</span>}
        {hint && <span className="text-slate-500">{hint}</span>}
      </div>
    </div>
  );
}
