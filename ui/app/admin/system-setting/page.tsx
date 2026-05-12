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
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useTranslations } from '@/lib/i18n';

interface SystemSetting {
  signup_enabled: boolean;
  maintenance_mode: boolean;
  announcement: string | null;
  announcement_level: 'info' | 'warn' | 'error';
  updated_at?: string;
}

export default function SystemSettingPage() {
  const [data, setData] = useState<SystemSetting | null>(null);
  const [draft, setDraft] = useState<string>(''); // announcement draft (text not auto-saved)
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const t = useTranslations('admin.system_setting');
  const tCommon = useTranslations('common');

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setErr('');
    try {
      const r = await api<SystemSetting>('/admin/system-setting');
      setData(r);
      setDraft(r.announcement ?? '');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function save(patch: Partial<SystemSetting>) {
    setSaving(true);
    setErr('');
    try {
      const r = await api<SystemSetting>('/admin/system-setting', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setData(r);
      if (patch.announcement !== undefined) setDraft(r.announcement ?? '');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell title={t('title')} subtitle={t('subtitle')}>
      {err && (
        <div className="mb-4 px-4 py-2 rounded-md border border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-sm">
          {err}
        </div>
      )}

      {loading || !data ? (
        <div className="space-y-4 max-w-3xl">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <div className="space-y-4 max-w-3xl">
          {/* Signup enabled */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('signup_title')}</CardTitle>
              <CardDescription>
                {t('signup_desc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Switch
                  checked={data.signup_enabled}
                  onCheckedChange={(v) => save({ signup_enabled: v })}
                  disabled={saving}
                  id="signup_enabled"
                />
                <Label htmlFor="signup_enabled" className="cursor-pointer">
                  {data.signup_enabled ? (
                    <span className="text-emerald-700 dark:text-emerald-400">{t('signup_on')}</span>
                  ) : (
                    <span className="text-muted-foreground">{t('signup_off')}</span>
                  )}
                </Label>
              </div>
            </CardContent>
          </Card>

          {/* Maintenance mode */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                {t('maint_title')}
                {data.maintenance_mode && (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400">
                    {t('maint_active_badge')}
                  </span>
                )}
              </CardTitle>
              <CardDescription className="text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {t('maint_desc')}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <Switch
                  checked={data.maintenance_mode}
                  onCheckedChange={(v) => {
                    if (v && !confirm(t('maint_confirm'))) return;
                    save({ maintenance_mode: v });
                  }}
                  disabled={saving}
                  id="maintenance_mode"
                />
                <Label htmlFor="maintenance_mode" className="cursor-pointer">
                  {data.maintenance_mode ? (
                    <span className="text-amber-700 dark:text-amber-400">{t('maint_on')}</span>
                  ) : (
                    <span className="text-emerald-700 dark:text-emerald-400">{t('maint_off')}</span>
                  )}
                </Label>
              </div>
            </CardContent>
          </Card>

          {/* Announcement */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('announce_title')}</CardTitle>
              <CardDescription>
                {t('announce_desc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label>{t('announce_level_label')}</Label>
                <Select
                  value={data.announcement_level || 'info'}
                  onValueChange={(v: 'info' | 'warn' | 'error') =>
                    save({ announcement_level: v })
                  }
                  disabled={saving}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">{t('announce_level_info')}</SelectItem>
                    <SelectItem value="warn">{t('announce_level_warn')}</SelectItem>
                    <SelectItem value="error">{t('announce_level_error')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('announce_content')}</Label>
                <textarea
                  className="w-full min-h-24 px-3 py-2 rounded-md border border-input bg-background text-sm"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('announce_placeholder')}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => save({ announcement: draft })}
                    disabled={saving || draft === (data.announcement ?? '')}
                  >
                    {saving ? tCommon('saving') : t('save_announce')}
                  </Button>
                  {draft !== (data.announcement ?? '') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDraft(data.announcement ?? '')}
                      disabled={saving}
                    >
                      {t('revert_changes')}
                    </Button>
                  )}
                  {data.announcement && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-rose-600"
                      onClick={() => save({ announcement: '' })}
                      disabled={saving}
                    >
                      {t('clear_announce')}
                    </Button>
                  )}
                </div>
              </div>
              {/* Preview */}
              {draft && (
                <div className="pt-2 border-t border-border">
                  <div className="text-xs text-muted-foreground mb-1.5">{t('preview')}</div>
                  <div
                    className={
                      'text-sm px-4 py-2 rounded-md border ' +
                      (data.announcement_level === 'error'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
                        : data.announcement_level === 'warn'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                        : 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400')
                    }
                  >
                    {draft}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {data.updated_at && (
            <p className="text-xs text-muted-foreground">
              {t('last_updated')}{new Date(data.updated_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </AdminShell>
  );
}
