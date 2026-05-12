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

interface PaymentConfig {
  alipay_app_id: string;
  alipay_private_key: string; // masked
  alipay_private_key_set: boolean;
  alipay_public_key: string; // masked
  alipay_public_key_set: boolean;
  usdt_trc20_address: string;
  usdt_erc20_address: string;
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
      setMsg('✓ 支付宝配置已保存');
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
      setMsg('✓ USDT 地址已保存');
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
      title="收款配置"
      subtitle="管理支付宝 / USDT 等终端用户支付方式（按 tenant 隔离，私钥服务端掩码）"
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
              支付宝
              {data.alipay_app_id && data.alipay_private_key_set && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  已配置
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="usdt" className="gap-1.5">
              <Coins className="h-4 w-4" />
              USDT
              {(data.usdt_trc20_address || data.usdt_erc20_address) && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  已配置
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="alipay">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">支付宝开放平台凭证</CardTitle>
                <CardDescription>
                  在
                  <a
                    href="https://open.alipay.com/develop/manage"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline mx-1"
                  >
                    支付宝开放平台
                  </a>
                  创建应用，配置 RSA2 公私钥后填入。私钥保存后服务端掩码，重新粘贴会覆盖。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>App ID</Label>
                  <Input
                    {...bind('alipay_app_id')}
                    placeholder="2021000123456789"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>
                    应用私钥 (RSA2){' '}
                    {data.alipay_private_key_set && !touched['alipay_private_key'] && (
                      <span className="text-xs text-muted-foreground font-normal">
                        当前：{data.alipay_private_key}（重新粘贴会覆盖）
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
                      未保存。点保存提交；点撤销则恢复原值。
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>
                    支付宝公钥{' '}
                    {data.alipay_public_key_set && !touched['alipay_public_key'] && (
                      <span className="text-xs text-muted-foreground font-normal">
                        当前：{data.alipay_public_key}（重新粘贴会覆盖）
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
                    {saving ? '保存中…' : '保存支付宝配置'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDraft(data);
                      setTouched({});
                    }}
                    disabled={saving}
                  >
                    撤销
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="usdt">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">USDT 收款地址</CardTitle>
                <CardDescription>
                  填入你的 TRC20 / ERC20 地址；用户下单后会展示二维码 + 等待回执确认。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-1.5">
                  <Label>TRC20 地址（推荐，gas 低）</Label>
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
                        <div>扫码即可识别地址</div>
                        <div className="font-mono break-all">{draft.usdt_trc20_address}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label>ERC20 地址（可选）</Label>
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
                        <div>扫码即可识别地址</div>
                        <div className="font-mono break-all">{draft.usdt_erc20_address}</div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveUsdt} disabled={saving}>
                    {saving ? '保存中…' : '保存 USDT 地址'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setDraft(data)}
                    disabled={saving}
                  >
                    撤销
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </AdminShell>
  );
}
