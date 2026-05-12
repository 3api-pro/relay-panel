'use client';
import { AdminShell } from '@/components/admin/AdminShell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart3 } from 'lucide-react';
import { useTranslations } from '@/lib/i18n';

export default function StatsPage() {
  const t = useTranslations('admin.stats');
  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <BarChart3 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>{t('card_title')}</CardTitle>
              <CardDescription>{t('card_desc')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t('card_body')}
        </CardContent>
      </Card>
    </AdminShell>
  );
}
