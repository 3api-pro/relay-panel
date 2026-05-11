'use client';
import { useEffect, useState } from 'react';
import { Plan, store } from '@/lib/store-api';
import { PlanCard } from '@/components/store/PlanCard';
import { Alert, Spinner } from '@/components/store/ui';

export default function PricingPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    store.plans()
      .then((r) => setPlans(r.data || []))
      .catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">选择你的套餐</h1>
        <p className="mt-3 text-slate-600">按月订阅, 无隐藏费用。可随时升级 / 取消。</p>
      </div>

      {err && (
        <div className="mt-8 max-w-xl mx-auto">
          <Alert kind="error">无法加载套餐: {err}</Alert>
        </div>
      )}

      {plans === null && !err && (
        <div className="mt-12 flex items-center justify-center text-slate-400">
          <Spinner /> <span className="ml-2 text-sm">加载中…</span>
        </div>
      )}

      {plans && plans.length === 0 && !err && (
        <div className="mt-12 max-w-xl mx-auto">
          <Alert kind="info">店主尚未配置套餐, 请稍后再来。</Alert>
        </div>
      )}

      {plans && plans.length > 0 && (
        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {plans.map((p, i) => (
            <PlanCard key={p.id} plan={p} recommended={plans.length >= 2 && i === 1} />
          ))}
        </div>
      )}

      <div className="mt-16 max-w-3xl mx-auto">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">常见问题</h2>
        <FAQ q="支持哪些客户端?">
          所有兼容 Anthropic Messages API 的工具 — Claude Code、Cursor、Cline、Continue、官方 SDK 等。
          只需把 baseUrl 改为本站 <code className="px-1 py-0.5 bg-slate-100 rounded text-xs">/v1</code>，
          API key 用本站签发的 <code className="px-1 py-0.5 bg-slate-100 rounded text-xs">sk-*</code>。
        </FAQ>
        <FAQ q="如何付款?">
          支持支付宝扫码、USDT-TRC20、USDT-ERC20。结账时选择即可。
        </FAQ>
        <FAQ q="额度怎么计算?">
          按 token 计费 (input + output)。每个 key 共用账户余额, 也可单独限额。
        </FAQ>
        <FAQ q="可以退款吗?">
          未消费 / 不超 7 天可以申请全额退款。详见 <a href="mailto:" className="underline">联系客服</a>。
        </FAQ>
      </div>
    </div>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="border-b border-slate-200 py-3">
      <summary className="cursor-pointer text-slate-900 font-medium list-none flex items-center justify-between">
        {q} <span className="text-slate-400 ml-2">+</span>
      </summary>
      <div className="mt-2 text-sm text-slate-600">{children}</div>
    </details>
  );
}
