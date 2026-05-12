'use client';
import { useEffect, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth, safe, fmtCNY } from '@/lib/api';

const STEPS = [
  { n: 1, title: '上游 Channel',   desc: '配置 API 转发的上游来源' },
  { n: 2, title: '品牌信息',       desc: '设置店铺名、Logo、配色' },
  { n: 3, title: '套餐定价',       desc: '审核 4 个默认套餐' },
  { n: 4, title: '收款方式',       desc: '配置支付宝 / USDT 收款' },
  { n: 5, title: '完成 & 邀请',    desc: '获取你的店铺链接' },
];

interface Channel {
  id: number; name: string; base_url: string; type: string;
  status: string; is_default: boolean; key_preview: string | null;
  // v0.3 — recommendation flag from migration 010.
  is_recommended?: boolean;
}

interface Plan {
  id: number; name: string; slug: string; period_days: number;
  quota_tokens: number; price_cents: number; enabled: boolean;
}

interface Me {
  admin?: { email: string };
  tenant?: { slug: string; saas_domain?: string | null };
}

interface Brand {
  store_name?: string;
  logo_url?: string;
  primary_color?: string;
  announcement?: string;
  footer_html?: string;
  contact_email?: string;
}

export default function OnboardingClient({ step: stepParam }: { step: string }) {
  const router = useRouter();
  const step = Math.max(1, Math.min(5, parseInt(stepParam, 10) || 1));

  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!auth.hasToken()) { router.push('/admin/login'); return; }
    setReady(true);
    if (typeof window !== 'undefined') {
      localStorage.setItem('onboarding_step', String(step));
    }
  }, [step, router]);

  function goto(n: number) {
    router.push(`/admin/onboarding/${Math.max(1, Math.min(5, n))}`);
  }

  function finish() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('onboarding_step');
      localStorage.setItem('onboarding_done', '1');
      // Clear any prior tour seen-flag so a freshly onboarded tenant
      // really gets the guided tour on the dashboard.
      try { localStorage.removeItem('3api_tour_done_v1'); } catch {}
    }
    router.push('/admin?tour=1');
  }

  if (!ready) {
    return <main className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">加载中…</main>;
  }

  return (
    <main className="min-h-screen bg-muted">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-2 text-sm text-muted-foreground">站长引导 · 5 步开店</div>
        <h1 className="text-2xl font-semibold text-foreground mb-6">{STEPS[step - 1].title}</h1>

        <StepIndicator current={step} />

        <div className="mt-6 bg-card rounded-lg border border-border p-6 min-h-[360px]">
          {step === 1 && <Step1Channels />}
          {step === 2 && <Step2Brand />}
          {step === 3 && <Step3Plans />}
          {step === 4 && <Step4Payment />}
          {step === 5 && <Step5Done onDone={finish} />}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={() => goto(step - 1)}
            disabled={step === 1}
            className="px-4 py-2 rounded-md border border-input text-sm text-foreground disabled:opacity-40 hover:bg-card"
          >
            ← 上一步
          </button>
          <div className="flex gap-2">
            {step < 5 && (
              <button
                onClick={() => goto(step + 1)}
                className="px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground"
              >
                跳过
              </button>
            )}
            {step < 5 ? (
              <button
                onClick={() => goto(step + 1)}
                className="px-5 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700"
              >
                继续 →
              </button>
            ) : (
              <button
                onClick={finish}
                className="px-5 py-2 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700"
              >
                进入控制台
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  Step indicator                                                     */
/* ------------------------------------------------------------------ */
function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center">
      {STEPS.map((s, idx) => {
        const done = s.n < current;
        const active = s.n === current;
        return (
          <div key={s.n} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div className={
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ' +
                (done ? 'bg-brand-600 text-white' :
                 active ? 'bg-brand-600 text-white ring-4 ring-brand-100' :
                 'bg-accent text-muted-foreground')
              }>
                {done ? '✓' : s.n}
              </div>
              <div className={
                'mt-1.5 text-xs whitespace-nowrap ' +
                (active ? 'text-foreground font-medium' : 'text-muted-foreground')
              }>{s.title}</div>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={'flex-1 h-0.5 mx-2 mb-5 ' + (done ? 'bg-brand-600' : 'bg-accent')} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 1: Channels — v0.3 dual-path                                  */
/*                                                                     */
/*  Two cards side-by-side:                                            */
/*    (left)  "Use recommended" → llmapi.pro wholesale, zero inventory */
/*    (right) "BYOK"            → bring your own Anthropic / OpenAI key */
/*                                                                     */
/*  "Use recommended" is one-click — we just mark the existing default */
/*  channel as is_recommended and bounce to step 2. "BYOK" jumps the   */
/*  reseller to /admin/channels where the new-channel modal already    */
/*  lives.                                                             */
/* ------------------------------------------------------------------ */
function Step1Channels() {
  const router = useRouter();
  const [list, setList] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    safe(api<{ data: Channel[] }>('/admin/channels'), { data: [] })
      .then((r) => setList(r.data || []))
      .finally(() => setLoading(false));
  }, []);

  const recommended = list.find((c) => (c as any).is_recommended) ?? null;
  const hasAnyChannel = list.length > 0;

  async function useRecommended() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      // If we already have a recommended channel, just advance. Otherwise
      // create the canonical llmapi.pro wholesale row and mark it default.
      if (!hasAnyChannel) {
        const created = await api<any>('/admin/channels', {
          method: 'POST',
          body: JSON.stringify({
            name: 'llmapi.pro Wholesale',
            base_url: 'https://api.llmapi.pro/wholesale/v1',
            api_key: 'platform-default-placeholder-key-replace-with-real',
            provider_type: 'llmapi-wholesale',
            type: 'wholesale-3api',
          }),
        });
        await api(`/admin/channels/${created.id}/set-default`, { method: 'POST' });
      }
      setMsg('已启用推荐上游，下一步');
      router.push('/admin/onboarding/2');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function goByok() {
    router.push('/admin/channels');
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        选择如何让客户的 /v1/messages 真转发出去。<b className="text-foreground">推荐</b>路径零库存、零谈判；<b className="text-foreground">BYOK</b>路径你完全控制谁是上游。
      </p>
      {(msg || err) && (
        <div
          className={
            'px-3 py-2 rounded-md border text-sm ' +
            (err
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400')
          }
        >
          {err || msg}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Recommended card */}
        <div
          className="rounded-lg border-2 border-brand-500 bg-brand-50/60 dark:bg-brand-950/30 p-5 flex flex-col"
          data-tour="onboarding-recommended"
        >
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-full bg-brand-600 text-white flex items-center justify-center text-sm font-bold">
              ★
            </div>
            <h3 className="text-base font-semibold text-foreground">使用推荐 (零库存)</h3>
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-brand-600 text-white">推荐</span>
          </div>
          <p className="text-sm text-foreground/80 mb-3">
            <b>llmapi.pro Wholesale</b> — 我方批发上游，已 baked。
          </p>
          <ul className="text-xs text-foreground/70 space-y-1.5 mb-4 flex-1">
            <li>• Claude 4.x / Sonnet / Haiku 全系</li>
            <li>• 0 配置，注册即开</li>
            <li>• 充值平台批发余额 = 库存</li>
            <li>• 每卖一单从余额扣 face value，不需要谈渠道</li>
          </ul>
          {recommended && (
            <div className="text-[11px] text-muted-foreground font-mono mb-3 truncate">
              当前: {recommended.name} · {recommended.base_url}
            </div>
          )}
          <button
            onClick={useRecommended}
            disabled={busy}
            className="w-full px-4 py-2.5 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? '启用中…' : recommended ? '一键启用 →' : '一键启用 →'}
          </button>
        </div>
        {/* BYOK card */}
        <div className="rounded-lg border border-border bg-card p-5 flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-full bg-muted text-foreground flex items-center justify-center text-sm font-bold">
              🔑
            </div>
            <h3 className="text-base font-semibold text-foreground">我有自己的 API Key (BYOK)</h3>
          </div>
          <p className="text-sm text-foreground/80 mb-3">
            Anthropic / OpenAI / 自建中转 — 完全自负。
          </p>
          <ul className="text-xs text-foreground/70 space-y-1.5 mb-4 flex-1">
            <li>• 自己谈渠道、自己控制成本</li>
            <li>• 需要先充值上游 API key (花的是你自己的钱)</li>
            <li>• 上游抖动 / 涨价 / 封号你独自承担</li>
            <li>• 多 key 轮询 / 协议适配 我们 baked</li>
          </ul>
          <button
            onClick={goByok}
            className="w-full px-4 py-2.5 rounded-md border border-input bg-background text-foreground text-sm font-medium hover:bg-muted"
          >
            配置 BYOK →
          </button>
        </div>
      </div>
      {hasAnyChannel && (
        <p className="text-xs text-muted-foreground text-center">
          已有 {list.length} 个 channel —{' '}
          <a href="/admin/channels" className="underline">在 channel 页查看</a>
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2: Brand                                                      */
/* ------------------------------------------------------------------ */
function Step2Brand() {
  const [brand, setBrand] = useState<Brand>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    safe(api<Brand>('/admin/brand'), {}).then((b) => setBrand(b || {}));
  }, []);

  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      await api('/admin/brand', { method: 'PATCH', body: JSON.stringify(brand) });
      setMsg('✓ 已保存');
    } catch (e: any) {
      setErr(`保存失败（接口可能未就绪）：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="店铺名称">
        <input type="text" value={brand.store_name ?? ''} onChange={(e) => setBrand({ ...brand, store_name: e.target.value })}
          placeholder="例如：算力中转站" className="w-full px-3 py-2 rounded-md border border-input" />
      </Field>
      <Field label="Logo URL">
        <input type="text" value={brand.logo_url ?? ''} onChange={(e) => setBrand({ ...brand, logo_url: e.target.value })}
          placeholder="https://..." className="w-full px-3 py-2 rounded-md border border-input" />
      </Field>
      <Field label="主题色">
        <div className="flex items-center gap-2">
          <input type="color" value={brand.primary_color ?? '#0e9486'} onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
            className="h-9 w-12 rounded border border-input" />
          <input type="text" value={brand.primary_color ?? '#0e9486'} onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
            className="flex-1 px-3 py-2 rounded-md border border-input font-mono text-sm" />
        </div>
      </Field>
      <Field label="联系邮箱">
        <input type="email" value={brand.contact_email ?? ''} onChange={(e) => setBrand({ ...brand, contact_email: e.target.value })}
          placeholder="support@example.com" className="w-full px-3 py-2 rounded-md border border-input" />
      </Field>
      <Field label="首页公告（可空）">
        <textarea value={brand.announcement ?? ''} onChange={(e) => setBrand({ ...brand, announcement: e.target.value })}
          rows={2} className="w-full px-3 py-2 rounded-md border border-input text-sm" />
      </Field>
      <div className="flex items-center justify-between pt-1">
        <div className="text-xs">
          {msg && <span className="text-emerald-600">{msg}</span>}
          {err && <span className="text-amber-700">{err}</span>}
        </div>
        <button onClick={save} disabled={busy}
          className="px-4 py-1.5 rounded-md bg-accent text-white text-sm hover:bg-foreground disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 3: Plans                                                      */
/* ------------------------------------------------------------------ */
function Step3Plans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    safe(api<{ data: Plan[] }>('/admin/plans'), { data: [] })
      .then((r) => setPlans(r.data || []))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(p: Plan) {
    const next = !p.enabled;
    setPlans((cur) => cur.map((x) => (x.id === p.id ? { ...x, enabled: next } : x)));
    try {
      await api(`/admin/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    } catch {
      setPlans((cur) => cur.map((x) => (x.id === p.id ? { ...x, enabled: !next } : x)));
    }
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        系统已为你预置 4 个标准套餐。这里可以快速启用 / 禁用，或前往 <a href="/admin/plans" className="text-brand-700 underline">套餐管理</a> 改价。
      </p>
      {loading ? (
        <div className="text-sm text-muted-foreground">加载中…</div>
      ) : plans.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂未检测到套餐（数据库可能未 seed）。</div>
      ) : (
        <div className="space-y-2">
          {plans.map((p) => (
            <div key={p.id} className="flex items-center gap-4 p-3 rounded-md border border-border">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {fmtCNY(p.price_cents)} / {p.period_days}天 ·{' '}
                  {p.quota_tokens === -1 ? '不限 token' : `${(p.quota_tokens / 1_000_000).toFixed(1)}M token`}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={p.enabled} onChange={() => toggle(p)} />
                <span className={p.enabled ? 'text-emerald-700' : 'text-muted-foreground'}>
                  {p.enabled ? '已上架' : '已下架'}
                </span>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 4: Payment                                                    */
/* ------------------------------------------------------------------ */
function Step4Payment() {
  const [alipayAppId, setAlipayAppId] = useState('');
  const [alipayKey, setAlipayKey] = useState('');
  const [usdtTrc, setUsdtTrc] = useState('');
  const [usdtErc, setUsdtErc] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    safe(api<any>('/admin/payment-config'), {}).then((c: any) => {
      setAlipayAppId(c?.alipay_app_id ?? '');
      setUsdtTrc(c?.usdt_trc20 ?? '');
      setUsdtErc(c?.usdt_erc20 ?? '');
    });
  }, []);

  async function save() {
    setBusy(true); setMsg(''); setErr('');
    try {
      await api('/admin/payment-config', {
        method: 'PATCH',
        body: JSON.stringify({
          alipay_app_id: alipayAppId || null,
          alipay_private_key: alipayKey || undefined,
          usdt_trc20: usdtTrc || null,
          usdt_erc20: usdtErc || null,
        }),
      });
      setMsg('✓ 已保存');
    } catch (e: any) {
      setErr(`后端 payment 接口暂未上线（payments agent 跟进），此步可先跳过：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-700">
        收款接口由 payments agent 提供。如果你现在还没收到这两行接口，先跳过本步——主流程不受阻。
      </div>
      <fieldset className="border border-border rounded-md p-4">
        <legend className="text-sm font-medium text-foreground px-1">支付宝</legend>
        <Field label="APP ID">
          <input type="text" value={alipayAppId} onChange={(e) => setAlipayAppId(e.target.value)}
            placeholder="2021..." className="w-full px-3 py-2 rounded-md border border-input text-sm font-mono" />
        </Field>
        <Field label="商户私钥（PEM）">
          <textarea value={alipayKey} onChange={(e) => setAlipayKey(e.target.value)}
            rows={3} placeholder="-----BEGIN RSA PRIVATE KEY-----..."
            className="w-full px-3 py-2 rounded-md border border-input text-xs font-mono" />
        </Field>
      </fieldset>
      <fieldset className="border border-border rounded-md p-4">
        <legend className="text-sm font-medium text-foreground px-1">USDT</legend>
        <Field label="TRC20 地址">
          <input type="text" value={usdtTrc} onChange={(e) => setUsdtTrc(e.target.value)}
            placeholder="T..." className="w-full px-3 py-2 rounded-md border border-input text-sm font-mono" />
        </Field>
        <Field label="ERC20 地址">
          <input type="text" value={usdtErc} onChange={(e) => setUsdtErc(e.target.value)}
            placeholder="0x..." className="w-full px-3 py-2 rounded-md border border-input text-sm font-mono" />
        </Field>
      </fieldset>
      <div className="flex items-center justify-between pt-1">
        <div className="text-xs">
          {msg && <span className="text-emerald-600">{msg}</span>}
          {err && <span className="text-amber-700">{err}</span>}
        </div>
        <button onClick={save} disabled={busy}
          className="px-4 py-1.5 rounded-md bg-accent text-white text-sm hover:bg-foreground disabled:opacity-50">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 5: Done                                                       */
/* ------------------------------------------------------------------ */
function Step5Done({ onDone }: { onDone: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    safe(api<Me>('/admin/me'), { admin: { email: '' }, tenant: { slug: 'your-shop' } }).then(setMe);
  }, []);

  const slug = me?.tenant?.slug ?? 'your-shop';
  const url = `https://${slug}.3api.pro`;

  function copy() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }

  return (
    <div className="text-center py-4">
      <div className="text-5xl mb-3">🎉</div>
      <h2 className="text-xl font-semibold text-foreground">你的店铺已开张</h2>
      <p className="text-sm text-muted-foreground mt-2">把这条链接发给你的用户，他们就能注册下单了。</p>

      <div className="mt-6 inline-flex items-center gap-2 bg-muted border border-border rounded-md px-4 py-2.5 font-mono text-sm">
        <span>{url}</span>
        <button onClick={copy} className="px-2 py-1 rounded bg-card border border-input hover:bg-muted text-xs">
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>

      <div className="mt-8 max-w-md mx-auto text-left text-sm text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">下一步建议</p>
        <ul className="space-y-1.5 list-disc list-inside">
          <li>到 <a href="/admin/finance" className="text-brand-700 underline">财务</a> 给 wholesale 余额充值（首次建议 ¥500）</li>
          <li>到 <a href="/admin/branding" className="text-brand-700 underline">品牌</a> 上传 logo 完成形象</li>
          <li>导出 <a href="/admin/users" className="text-brand-700 underline">推广素材</a>，发到目标社区</li>
        </ul>
      </div>

      <button onClick={onDone} className="mt-8 px-6 py-2.5 rounded-md bg-brand-600 text-white text-sm hover:bg-brand-700">
        进入控制台
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Small helper                                                        */
/* ------------------------------------------------------------------ */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}
