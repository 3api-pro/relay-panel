'use client';
import { useEffect, useState } from 'react';

import { AdminShell } from '@/components/admin/AdminShell';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditCard, Coins, Check, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface PaymentConfig {
  alipay_app_id: string;
  alipay_private_key: string;
  alipay_private_key_set: boolean;
  alipay_public_key: string;
  alipay_public_key_set: boolean;
  usdt_trc20_address: string;
  usdt_erc20_address: string;
  // International providers (per-tenant override; empty = platform fallback)
  paypal_client_id?: string;
  paypal_client_secret?: string;
  paypal_client_secret_set?: boolean;
  paypal_environment?: 'sandbox' | 'live';
  stripe_secret_key?: string;
  stripe_secret_key_set?: boolean;
  stripe_webhook_secret?: string;
  stripe_webhook_secret_set?: boolean;
  stripe_mode?: 'test' | 'live';
  creem_api_key?: string;
  creem_api_key_set?: boolean;
  creem_webhook_secret?: string;
  creem_webhook_secret_set?: boolean;
  creem_environment?: 'test' | 'live';
}

const EMPTY: PaymentConfig = {
  alipay_app_id: '',
  alipay_private_key: '',
  alipay_private_key_set: false,
  alipay_public_key: '',
  alipay_public_key_set: false,
  usdt_trc20_address: '',
  usdt_erc20_address: '',
};

export default function PaymentConfigPage() {
  const [data, setData] = useState<PaymentConfig | null>(null);
  const [draft, setDraft] = useState<PaymentConfig>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // Track which secret fields the user has touched (≠ masked echo)
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const t = useTranslations('admin.payment_config');
  const tCommon = useTranslations('common');

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setErr('');
    try {
      const r = await api<PaymentConfig>('/admin/payment-config');
      setData(r);
      setDraft(r);
      setTouched({});
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveAlipay() {
    setSaving(true);
    setErr('');
    setMsg('');
    try {
      const patch: Record<string, string> = {
        alipay_app_id: draft.alipay_app_id,
      };
      // Only send secret fields if the user actually typed something new
      if (touched['alipay_private_key']) {
        patch.alipay_private_key = draft.alipay_private_key;
      }
      if (touched['alipay_public_key']) {
        patch.alipay_public_key = draft.alipay_public_key;
      }
      const r = await api<PaymentConfig>('/admin/payment-config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setData(r);
      setDraft(r);
      setTouched({});
      setMsg(t('save_alipay_ok'));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveUsdt() {
    setSaving(true);
    setErr('');
    setMsg('');
    try {
      const patch: Record<string, string> = {
        usdt_trc20_address: draft.usdt_trc20_address,
        usdt_erc20_address: draft.usdt_erc20_address,
      };
      const r = await api<PaymentConfig>('/admin/payment-config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setData(r);
      setDraft(r);
      setMsg(t('save_usdt_ok'));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveIntl() {
    setSaving(true); setErr(''); setMsg('');
    try {
      const patch: Record<string, string> = {};
      // PayPal — only id is plain; secret only when touched
      if (touched['paypal_client_id'] || draft.paypal_client_id !== undefined) {
        patch.paypal_client_id = draft.paypal_client_id || '';
      }
      if (touched['paypal_client_secret']) patch.paypal_client_secret = draft.paypal_client_secret || '';
      if (touched['paypal_environment']) patch.paypal_environment = draft.paypal_environment || 'sandbox';
      // Stripe
      if (touched['stripe_secret_key']) patch.stripe_secret_key = draft.stripe_secret_key || '';
      if (touched['stripe_webhook_secret']) patch.stripe_webhook_secret = draft.stripe_webhook_secret || '';
      if (touched['stripe_mode']) patch.stripe_mode = draft.stripe_mode || 'test';
      // Creem
      if (touched['creem_api_key']) patch.creem_api_key = draft.creem_api_key || '';
      if (touched['creem_webhook_secret']) patch.creem_webhook_secret = draft.creem_webhook_secret || '';
      if (touched['creem_environment']) patch.creem_environment = draft.creem_environment || 'live';
      if (Object.keys(patch).length === 0) { setMsg('没有改动'); return; }
      const r = await api<PaymentConfig>('/admin/payment-config', {
        method: 'PATCH', body: JSON.stringify(patch),
      });
      setData(r); setDraft(r); setTouched({}); setMsg('已保存国际收款配置');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function bind<K extends keyof PaymentConfig>(field: K) {
    return {
      value: String(draft[field] ?? ''),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setDraft((d) => ({ ...d, [field]: e.target.value }) as PaymentConfig);
        setTouched((t) => ({ ...t, [field]: true }));
      },
    };
  }

  return (
    <AdminShell
      title={t('title')}
      subtitle={t('subtitle')}
    >
      {err && (
        <div className="mb-4 px-4 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {err}
        </div>
      )}
      {msg && (
        <div className="mb-4 px-4 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-sm flex items-center gap-2">
          <Check className="h-4 w-4" />
          {msg}
        </div>
      )}

      {loading || !data ? (
        <Skeleton className="h-96 w-full max-w-3xl" />
      ) : (
        <Tabs defaultValue="alipay" className="max-w-3xl">
          <TabsList>
            <TabsTrigger value="alipay" className="gap-1.5">
              <CreditCard className="h-4 w-4" />
              {t('alipay_tab')}
              {data.alipay_app_id && data.alipay_private_key_set && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  {t('configured_badge')}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="usdt" className="gap-1.5">
              <Coins className="h-4 w-4" />
              {t('usdt_tab')}
              {(data.usdt_trc20_address || data.usdt_erc20_address) && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  {t('configured_badge')}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="alipay">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('alipay_card_title')}</CardTitle>
                <CardDescription>
                  {t('alipay_card_desc_pre')}
                  <a
                    href="https://open.alipay.com/develop/manage"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline mx-1"
                  >
                    {t('alipay_card_desc_link')}
                  </a>
                  {t('alipay_card_desc_post')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>{t('field_app_id')}</Label>
                  <Input
                    {...bind('alipay_app_id')}
                    placeholder="2021000123456789"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    {t('field_private_key')}{' '}
                    {data.alipay_private_key_set && !touched['alipay_private_key'] && (
                      <span className="text-xs text-muted-foreground font-normal">
                        {t('current_masked_prefix')}{data.alipay_private_key}{t('current_masked_tail')}
                      </span>
                    )}
                  </Label>
                  <textarea
                    value={
                      touched['alipay_private_key']
                        ? draft.alipay_private_key
                        : data.alipay_private_key_set
                        ? ''
                        : draft.alipay_private_key
                    }
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, alipay_private_key: e.target.value }));
                      setTouched((t) => ({ ...t, alipay_private_key: true }));
                    }}
                    placeholder="-----BEGIN RSA PRIVATE KEY-----..."
                    rows={6}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-xs font-mono"
                  />
                  {touched['alipay_private_key'] && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {t('private_key_unsaved')}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>
                    {t('field_public_key')}{' '}
                    {data.alipay_public_key_set && !touched['alipay_public_key'] && (
                      <span className="text-xs text-muted-foreground font-normal">
                        {t('current_masked_prefix')}{data.alipay_public_key}{t('current_masked_tail')}
                      </span>
                    )}
                  </Label>
                  <textarea
                    value={
                      touched['alipay_public_key']
                        ? draft.alipay_public_key
                        : data.alipay_public_key_set
                        ? ''
                        : draft.alipay_public_key
                    }
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, alipay_public_key: e.target.value }));
                      setTouched((t) => ({ ...t, alipay_public_key: true }));
                    }}
                    placeholder="-----BEGIN PUBLIC KEY-----..."
                    rows={4}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-xs font-mono"
                  />
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveAlipay} disabled={saving}>
                    {saving ? tCommon('saving') : t('save_alipay')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDraft(data);
                      setTouched({});
                    }}
                    disabled={saving}
                  >
                    {tCommon('undo')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usdt">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('usdt_card_title')}</CardTitle>
                <CardDescription>
                  {t('usdt_card_desc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-1.5">
                  <Label>{t('field_trc20')}</Label>
                  <Input
                    {...bind('usdt_trc20_address')}
                    placeholder="TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    className="font-mono text-sm"
                  />
                  {draft.usdt_trc20_address && (
                    <div className="pt-1.5 flex gap-3 items-start">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(
                          'tron:' + draft.usdt_trc20_address,
                        )}`}
                        alt="TRC20 QR"
                        width={120}
                        height={120}
                        className="rounded-md border border-border"
                      />
                      <div className="text-xs text-muted-foreground space-y-1 pt-2">
                        <div>{t('scan_hint')}</div>
                        <div className="font-mono break-all">{draft.usdt_trc20_address}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>{t('field_erc20')}</Label>
                  <Input
                    {...bind('usdt_erc20_address')}
                    placeholder="0x..."
                    className="font-mono text-sm"
                  />
                  {draft.usdt_erc20_address && (
                    <div className="pt-1.5 flex gap-3 items-start">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(
                          draft.usdt_erc20_address,
                        )}`}
                        alt="ERC20 QR"
                        width={120}
                        height={120}
                        className="rounded-md border border-border"
                      />
                      <div className="text-xs text-muted-foreground space-y-1 pt-2">
                        <div>{t('scan_hint')}</div>
                        <div className="font-mono break-all">{draft.usdt_erc20_address}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveUsdt} disabled={saving}>
                    {saving ? tCommon('saving') : t('save_usdt')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setDraft(data)}
                    disabled={saving}
                  >
                    {tCommon('undo')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <div className="mt-8 bg-card border border-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-2">
          <CreditCard className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">国际收款 (per-tenant 覆盖)</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          配你自己的 PayPal / Stripe / Creem 凭据 — 客户付款直接进你的账户。<strong>留空则平台代收</strong>（钱进你的钱包，可提现或抵 llmapi 续费）。
        </p>

        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold mb-2">PayPal</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pp_id" className="text-xs">Client ID</Label>
                <Input id="pp_id" value={draft.paypal_client_id || ''}
                  placeholder="留空走平台"
                  onChange={(e) => { setDraft({ ...draft, paypal_client_id: e.target.value }); setTouched((t) => ({ ...t, paypal_client_id: true })); }} />
              </div>
              <div>
                <Label htmlFor="pp_sec" className="text-xs">Client Secret {draft.paypal_client_secret_set && <span className="text-xs text-emerald-600 ml-1">✓</span>}</Label>
                <Input id="pp_sec" type="password" value={draft.paypal_client_secret || ''}
                  placeholder={draft.paypal_client_secret_set ? '（不变）输入新值替换' : ''}
                  onChange={(e) => { setDraft({ ...draft, paypal_client_secret: e.target.value }); setTouched((t) => ({ ...t, paypal_client_secret: true })); }} />
              </div>
              <div>
                <Label htmlFor="pp_env" className="text-xs">环境</Label>
                <select id="pp_env" value={draft.paypal_environment || 'sandbox'}
                  onChange={(e) => { setDraft({ ...draft, paypal_environment: e.target.value as 'sandbox' | 'live' }); setTouched((t) => ({ ...t, paypal_environment: true })); }}
                  className="w-full h-9 px-3 border border-input bg-background rounded-md text-sm">
                  <option value="sandbox">Sandbox</option>
                  <option value="live">Live</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Stripe</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="st_sk" className="text-xs">Secret Key {draft.stripe_secret_key_set && <span className="text-xs text-emerald-600 ml-1">✓</span>}</Label>
                <Input id="st_sk" type="password" value={draft.stripe_secret_key || ''}
                  placeholder={draft.stripe_secret_key_set ? '（不变）输入新值替换' : 'sk_live_… 或 sk_test_…'}
                  onChange={(e) => { setDraft({ ...draft, stripe_secret_key: e.target.value }); setTouched((t) => ({ ...t, stripe_secret_key: true })); }} />
              </div>
              <div>
                <Label htmlFor="st_wh" className="text-xs">Webhook Signing Secret {draft.stripe_webhook_secret_set && <span className="text-xs text-emerald-600 ml-1">✓</span>}</Label>
                <Input id="st_wh" type="password" value={draft.stripe_webhook_secret || ''}
                  placeholder={draft.stripe_webhook_secret_set ? '（不变）输入新值替换' : 'whsec_…'}
                  onChange={(e) => { setDraft({ ...draft, stripe_webhook_secret: e.target.value }); setTouched((t) => ({ ...t, stripe_webhook_secret: true })); }} />
              </div>
              <div>
                <Label htmlFor="st_mode" className="text-xs">模式</Label>
                <select id="st_mode" value={draft.stripe_mode || 'test'}
                  onChange={(e) => { setDraft({ ...draft, stripe_mode: e.target.value as 'test' | 'live' }); setTouched((t) => ({ ...t, stripe_mode: true })); }}
                  className="w-full h-9 px-3 border border-input bg-background rounded-md text-sm">
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Webhook URL: <code className="text-xs">https://3api.pro/payments/stripe/webhook</code></p>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Creem</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="cr_ak" className="text-xs">API Key {draft.creem_api_key_set && <span className="text-xs text-emerald-600 ml-1">✓</span>}</Label>
                <Input id="cr_ak" type="password" value={draft.creem_api_key || ''}
                  placeholder={draft.creem_api_key_set ? '（不变）输入新值替换' : 'creem_…'}
                  onChange={(e) => { setDraft({ ...draft, creem_api_key: e.target.value }); setTouched((t) => ({ ...t, creem_api_key: true })); }} />
              </div>
              <div>
                <Label htmlFor="cr_wh" className="text-xs">Webhook Secret {draft.creem_webhook_secret_set && <span className="text-xs text-emerald-600 ml-1">✓</span>}</Label>
                <Input id="cr_wh" type="password" value={draft.creem_webhook_secret || ''}
                  placeholder={draft.creem_webhook_secret_set ? '（不变）输入新值替换' : 'whsec_…'}
                  onChange={(e) => { setDraft({ ...draft, creem_webhook_secret: e.target.value }); setTouched((t) => ({ ...t, creem_webhook_secret: true })); }} />
              </div>
              <div>
                <Label htmlFor="cr_env" className="text-xs">环境</Label>
                <select id="cr_env" value={draft.creem_environment || 'live'}
                  onChange={(e) => { setDraft({ ...draft, creem_environment: e.target.value as 'test' | 'live' }); setTouched((t) => ({ ...t, creem_environment: true })); }}
                  className="w-full h-9 px-3 border border-input bg-background rounded-md text-sm">
                  <option value="test">Test</option>
                  <option value="live">Live</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <Button onClick={saveIntl} disabled={saving} className="mt-6">
          {saving ? '保存中…' : '保存国际收款配置'}
        </Button>
      </div>

        </AdminShell>
  );
}
