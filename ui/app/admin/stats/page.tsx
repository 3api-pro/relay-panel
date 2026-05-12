'use client';
import { AdminShell } from '@/components/admin/AdminShell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart3 } from 'lucide-react';

export default function StatsPage() {
  return (
    <AdminShell title="数据" subtitle="深度业务分析（v0.2 W3 上线）">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>数据看板筹备中</CardTitle>
              <CardDescription>计划：留存 cohort · 套餐转化漏斗 · 上游单价毛利 · 关键流失指标</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          v0.2 W3 sprint 将上线第一批分析报表。当前可在「总览」查看实时核心指标。
        </CardContent>
      </Card>
    </AdminShell>
  );
}
