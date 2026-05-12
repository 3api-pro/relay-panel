'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Search, ChevronRight, LogOut, Settings as SettingsIcon, User } from 'lucide-react';
import { auth } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

const ROUTE_LABELS: Record<string, string> = {
  '/admin':                 '总览',
  '/admin/stats':           '数据',
  '/admin/plans':           '套餐管理',
  '/admin/orders':          '订单',
  '/admin/users':           '终端用户',
  '/admin/channels':        '上游 Channel',
  '/admin/wholesale':       '批发余额',
  '/admin/finance':         '财务',
  '/admin/branding':        '品牌',
  '/admin/payment-config':  '收款配置',
  '/admin/settings':        '账号设置',
  '/admin/dashboard':       '仪表盘',
  '/admin/onboarding':      '新店向导',
};

interface Props { title?: string; subtitle?: string; actions?: React.ReactNode }

export function TopBar({ title, subtitle, actions }: Props) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const [email, setEmail] = useState<string>('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_profile');
      if (raw) setEmail(JSON.parse(raw).email || '');
    } catch {}
  }, []);

  const resolvedTitle = title || ROUTE_LABELS[pathname] || '后台';

  function logout() {
    auth.clearToken();
    try { localStorage.removeItem('admin_profile'); } catch {}
    router.push('/');
  }

  return (
    <header className="h-14 px-6 border-b border-border bg-card flex items-center justify-between gap-4 sticky top-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <nav className="flex items-center text-sm text-muted-foreground">
          <Link href="/admin" className="hover:text-foreground transition-colors">控制台</Link>
          <ChevronRight className="h-3.5 w-3.5 mx-1 opacity-60" />
          <span className="text-foreground font-medium">{resolvedTitle}</span>
        </nav>
        {subtitle && (
          <span className="text-xs text-muted-foreground border-l border-border pl-3 ml-1 hidden sm:inline">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {actions}
        <div className="hidden md:flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-muted-foreground text-xs cursor-not-allowed opacity-70">
          <Search className="h-3.5 w-3.5" />
          <span>搜索</span>
          <kbd className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-muted border border-border">Ctrl K</kbd>
        </div>
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="账号菜单" className="h-9 w-9">
              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                {(email[0] || 'A').toUpperCase()}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuLabel>
              <div className="text-xs text-muted-foreground">已登录</div>
              <div className="text-sm font-medium truncate">{email || '管理员'}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/admin/settings')}>
              <SettingsIcon className="mr-2 h-4 w-4" /> 账号设置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/admin/branding')}>
              <User className="mr-2 h-4 w-4" /> 品牌资料
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" /> 退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
