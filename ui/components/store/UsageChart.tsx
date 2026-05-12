'use client';
/**
 * Minimal SVG line chart — no chart library dependency to keep bundle small.
 * `data` is [{date, tokens}] for the time range; missing days render as 0.
 */
import { useTranslations } from '@/lib/i18n';

export interface UsagePoint { date: string; tokens: number; requests?: number; }

export function UsageChart({ data, height = 180 }: { data: UsagePoint[]; height?: number }) {
  const t = useTranslations('storefront.usage_chart');
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-sm" style={{ height }}>
        {t('no_data')}
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.tokens));
  const padX = 40, padY = 16;
  const W = 700, H = height;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

  const points = data.map((d, i) => {
    const x = padX + i * stepX;
    const y = padY + innerH * (1 - d.tokens / max);
    return [x, y] as const;
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const areaPath = `${path} L ${points[points.length - 1][0].toFixed(1)} ${H - padY} L ${points[0][0].toFixed(1)} ${H - padY} Z`;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="usage-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--brand-primary, #0e9486)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--brand-primary, #0e9486)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* axes */}
        <line x1={padX} x2={W - padX} y1={H - padY} y2={H - padY} stroke="#e2e8f0" />
        {/* grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padX} x2={W - padX}
            y1={padY + innerH * f} y2={padY + innerH * f}
            stroke="#f1f5f9" strokeDasharray="3 3" />
        ))}
        {/* area */}
        <path d={areaPath} fill="url(#usage-grad)" />
        {/* line */}
        <path d={path} fill="none" stroke="var(--brand-primary, #0e9486)" strokeWidth="2" />
        {/* points */}
        {points.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="var(--brand-primary, #0e9486)">
            <title>{data[i].date}: {data[i].tokens.toLocaleString()} tokens</title>
          </circle>
        ))}
        {/* x labels */}
        {data.map((d, i) => {
          if (data.length > 10 && i % 2 !== 0 && i !== data.length - 1) return null;
          const x = padX + i * stepX;
          return (
            <text key={i} x={x} y={H - 2} fontSize="10" textAnchor="middle" fill="#94a3b8">
              {d.date.slice(5)}
            </text>
          );
        })}
        {/* y labels */}
        <text x={padX - 6} y={padY + 4} fontSize="10" textAnchor="end" fill="#94a3b8">{max.toLocaleString()}</text>
        <text x={padX - 6} y={H - padY} fontSize="10" textAnchor="end" fill="#94a3b8">0</text>
      </svg>
    </div>
  );
}
