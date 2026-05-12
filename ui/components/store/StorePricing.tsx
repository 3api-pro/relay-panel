'use client';
/**
 * Subdomain (storefront) pricing UI — renders the tenant's configured plans.
 * Reusable component invoked from app/pricing/page.tsx in host=store mode.
 */
import { useEffect, useState } from 'react';
import { Plan, store } from '@/lib/store-api';
import { PlanCard } from '@/components/store/PlanCard';
import { Alert, Spinner } from '@/components/store/ui';

export function StorePricing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    store.plans()
      .then((r) => setPlans(r.data || []))
      .catch((e) => setErr(e.message));
  }, []);

  // Pick a "recommended" plan: roughly the middle one for visual centering.
  const recommendedIdx = (() => {
    if (!plans || plans.length === 0) return -1;
    if (plans.length === 1) return 0;
    if (plans.length >= 4) return 1;
    return Math.floor(plans.length / 2);
  })();

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">选择你的套餐</h1>
        <p className="mt-3 text-muted-foreground">按月订阅, 无隐藏费用。可随时升级 / 取消。</p>
      </div>

      {err && (
        <div className="mt-8 max-w-xl mx-auto">
          <Alert kind="error">无法加载套餐: {err}</Alert>
        </div>
      )}

      {plans === null && !err && (
        <div className="mt-12 flex items-center justify-center text-muted-foreground">
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
            <PlanCard key={p.id} plan={p} recommended={i === recommendedIdx} />
          ))}
        </div>
      )}

      <div className="mt-16 max-w-3xl mx-auto">
        <h2 className="text-xl font-semibold text-foreground mb-4">常见问题</h2>
        <FAQ q="怎么用 API？">
          所有兼容 Anthropic Messages API 的工具 — Claude Code、Cursor、Cline、Continue、官方 SDK 等都可直接使用。
          把 baseUrl 改为本站 <code className="px-1 py-0.5 bg-muted rounded text-xs">/v1</code>，
          Authorization 头填本站签发的 <code className="px-1 py-0.5 bg-muted rounded text-xs">sk-*</code> Key。
          详见 <a href="/docs" className="underline">API 文档</a>。
        </FAQ>
        <FAQ q="如何充值 / 续费？">
          支持支付宝扫码、USDT-TRC20、USDT-ERC20。订阅到期前可手动续费，避免服务中断。
        </FAQ>
        <FAQ q="退款政策？">
          未消费 / 不超 7 天可申请全额退款。已消费部分按 token 数量比例扣减。详见使用条款或联系店主。
        </FAQ>
        <FAQ q="额度怎么计算？">
          按 token 计费（input + output 合计）。每个 API Key 共用账户订阅余额，可单独限额防止误用。
        </FAQ>
        <FAQ q="联系客服">
          有问题可邮件联系店主，或在 Dashboard → 账号设置 中查看联系方式。
        </FAQ>
      </div>
    </div>
  );
}

function FAQ({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="border-b border-border py-3">
      <summary className="cursor-pointer text-foreground font-medium list-none flex items-center justify-between">
        {q} <span className="text-muted-foreground ml-2">+</span>
      </summary>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}
