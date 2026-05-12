'use client';
import { AdminShell } from '@/components/admin/AdminShell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CreditCard } from 'lucide-react';
import Link from 'next/link';

export default function PaymentConfigPage() {
  return (
    <AdminShell title="收款配置" subtitle="管理 Alipay / USDT 等终端用户支付方式">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>独立收款配置页（即将拆分）</CardTitle>
              <CardDescription>当前 Alipay / USDT 配置仍在「新店向导 Step 4」与「账号设置」中</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>v0.2 W3 计划把支付配置独立成专门管理页（含密钥校验 · 沙箱测试 · 回调验证）。</p>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/admin/settings">前往账号设置</Link>
            </Button>
            <Button asChild>
              <Link href="/admin/onboarding/4">向导 · Step 4</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </AdminShell>
  );
}
