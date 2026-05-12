'use client';
import { ReactNode, useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /**
   * Series data for the sparkline.
   * Each number is one bucket (typically day). Last value = latest.
   */
  data?: number[];
  /** Explicit delta % override; otherwise derived from first vs last data point. */
  deltaPct?: number | null;
  /** Optional explicit direction; otherwise derived from deltaPct sign. */
  deltaDirection?: 'up' | 'down' | 'flat';
  /** Deprecated; kept for backwards compatibility. */
  trend?: 'up' | 'down' | null;
  trendValue?: string;
}

/**
 * Stat card with optional inline sparkline + delta arrow.
 * Single brand-teal — no rainbow / no AI gradient (see feedback_no_ai_gradient).
 */
export function StatCard({
  label, value, hint, data, deltaPct, deltaDirection, trend, trendValue,
}: Props) {
  // Derive delta if not explicitly given
  const derived = useMemo(() => {
    if (deltaPct != null) {
      return {
        pct: deltaPct,
        dir: (deltaDirection ?? (deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat')) as 'up' | 'down' | 'flat',
      };
    }
    if (data && data.length >= 2) {
      const first = data[0];
      const last  = data[data.length - 1];
      if (first === 0 && last === 0) return { pct: 0, dir: 'flat' as const };
      const base = first === 0 ? 1 : first;
      const pct  = ((last - first) / Math.abs(base)) * 100;
      return { pct, dir: (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat' };
    }
    return null;
  }, [data, deltaPct, deltaDirection]);

  return (
    <Card className="p-5 flex flex-col gap-3">
      <div>
        <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className="text-2xl font-semibold text-foreground mt-1.5 leading-tight">{value}</div>
      </div>

      <div className="flex items-end justify-between gap-3 mt-auto">
        <div className="text-xs flex items-center gap-1.5 min-w-0">
          {derived && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded font-medium',
                derived.dir === 'up'   && 'text-emerald-600 bg-emerald-500/10',
                derived.dir === 'down' && 'text-rose-600    bg-rose-500/10',
                derived.dir === 'flat' && 'text-muted-foreground bg-muted',
              )}
            >
              {derived.dir === 'up'   && <ArrowUp   className="h-3 w-3" />}
              {derived.dir === 'down' && <ArrowDown className="h-3 w-3" />}
              {derived.dir === 'flat' && <Minus     className="h-3 w-3" />}
              {Math.abs(derived.pct).toFixed(1)}%
            </span>
          )}
          {/* legacy props still supported */}
          {!derived && trend === 'up'   && <span className="text-emerald-600">↑ {trendValue}</span>}
          {!derived && trend === 'down' && <span className="text-rose-600">↓ {trendValue}</span>}
          {hint && <span className="text-muted-foreground truncate">{hint}</span>}
        </div>
        {data && data.length >= 2 && <Sparkline data={data} />}
      </div>
    </Card>
  );
}

function Sparkline({ data }: { data: number[] }) {
  // Inline pure-SVG sparkline so we stay zero-dep at render time
  // (recharts is available in the bundle but tiny SVG is faster + lighter for this).
  const w = 80, h = 28, pad = 2;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  // Area fill below the line for soft depth
  const areaD = `${d} L ${pts[pts.length - 1][0].toFixed(1)} ${(h - pad).toFixed(1)} L ${pad.toFixed(1)} ${(h - pad).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="shrink-0 text-primary">
      <path d={areaD} fill="currentColor" opacity={0.12} />
      <path d={d}     fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
