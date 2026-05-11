'use client';
import Link from 'next/link';
import { Plan, fmtCents, fmtTokens, parseAllowedModels } from '@/lib/store-api';
import { Badge } from './ui';

export function PlanCard({ plan, recommended = false }: { plan: Plan; recommended?: boolean }) {
  const models = parseAllowedModels(plan.allowed_models);
  return (
    <div className={`relative rounded-xl border bg-white p-6 flex flex-col ${recommended ? 'border-2 shadow-md' : 'border-slate-200'}`}
         style={recommended ? { borderColor: 'var(--brand-primary, #0e9486)' } : undefined}>
      {recommended && (
        <div className="absolute -top-3 right-4">
          <Badge tone="brand">推荐</Badge>
        </div>
      )}
      <div className="text-lg font-semibold text-slate-900">{plan.name}</div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-slate-900">{fmtCents(plan.price_cents)}</span>
        <span className="text-sm text-slate-500">/ {plan.period_days} 天</span>
      </div>
      <ul className="mt-5 space-y-2 text-sm text-slate-700 flex-1">
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>{fmtTokens(plan.quota_tokens)} tokens 额度</span>
        </li>
        {models.length > 0 && (
          <li className="flex items-start gap-2">
            <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
            <span className="break-all">支持模型: {models.slice(0, 3).join(', ')}{models.length > 3 ? '…' : ''}</span>
          </li>
        )}
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>Anthropic Messages API 兼容</span>
        </li>
        <li className="flex items-start gap-2">
          <span style={{ color: 'var(--brand-primary, #0e9486)' }}>✓</span>
          <span>多 Key 管理 / 使用统计</span>
        </li>
      </ul>
      <Link href={`/signup?plan=${plan.slug}`}
        className="mt-6 inline-flex items-center justify-center px-4 py-2 rounded-md text-sm font-medium text-white hover:opacity-90"
        style={{ background: 'var(--brand-primary, #0e9486)' }}>
        选择此套餐
      </Link>
    </div>
  );
}
