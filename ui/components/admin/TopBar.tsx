'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Search, ChevronRight, LogOut, Settings as SettingsIcon, User, Menu } from 'lucide-react';
import { auth } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { openCommandPalette } from '@/components/CommandPalette';
import { resetOnboardingTour } from '@/components/OnboardingTour';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useTranslations } from '@/lib/i18n';

interface Props { title?: string; subtitle?: string; actions?: React.ReactNode; onMobileMenu?: () => void }

export function TopBar({ title, subtitle, actions, onMobileMenu }: Props) {
  const pathname = usePathname() || '';
  const router = useRouter();
  const [email, setEmail] = useState<string>('');
  const t = useTranslations('admin.topbar');
  const tNav = useTranslations('admin.sidebar.items');
  const tCommon = useTranslations('common');
  const tAdmin = useTranslations('admin');

  // Route → translation key in admin.sidebar.items.
  const ROUTE_TO_KEY: Record<string, string> = {
    '/admin':                 'dashboard',
    '/admin/stats':           'stats',
    '/admin/plans':           'plans',
    '/admin/orders':          'orders',
    '/admin/users':           'users',
    '/admin/channels':        'channels',
    '/admin/wholesale':       'wholesale',
    '/admin/finance':         'wholesale', // re-use label for now
    '/admin/branding':        'branding',
    '/admin/payment-config':  'payment_config',
    '/admin/settings':        'settings',
    '/admin/dashboard':       'dashboard',
    '/admin/onboarding':      'onboarding',
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_profile');
      if (raw) setEmail(JSON.parse(raw).email || '');
    } catch {}
  }, []);

  const routeKey = ROUTE_TO_KEY[pathname];
  const resolvedTitle = title || (routeKey ? tNav(routeKey) : tAdmin('console_panel'));

  function logout() {
    auth.clearToken();
    try { localStorage.removeItem('admin_profile'); } catch {}
    router.push('/');
  }

  return (
    <header className="h-14 px-4 md:px-6 border-b border-border bg-card flex items-center justify-between gap-2 md:gap-4 sticky top-0 z-30">
      <div className="flex items-center gap-2 md:gap-3 min-w-0">
        {onMobileMenu && (
          <button
            type="button"
            onClick={onMobileMenu}
            aria-label={t('open_menu')}
            className="md:hidden -ml-1 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <nav className="flex items-center text-sm text-muted-foreground min-w-0">
          <Link href="/admin" className="hover:text-foreground transition-colors hidden sm:inline">{tAdmin('console')}</Link>
          <ChevronRight className="h-3.5 w-3.5 mx-1 opacity-60 hidden sm:inline" />
          <span className="text-foreground font-medium truncate">{resolvedTitle}</span>
        </nav>
        {subtitle && (
          <span className="text-xs text-muted-foreground border-l border-border pl-3 ml-1 hidden sm:inline">
            {subtitle}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {actions}
        <button
          type="button"
          data-tour="topbar-cmdk"
          onClick={openCommandPalette}
          aria-label={t('open_palette')}
          className="hidden md:flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-muted-foreground text-xs hover:text-foreground hover:bg-accent transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span>{tCommon('search')}</span>
          <kbd className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-muted border border-border">Ctrl K</kbd>
        </button>
        <LanguageSwitcher />
        <div data-tour="topbar-theme"><ThemeToggle /></div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('account_menu')} className="h-9 w-9">
              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                {(email[0] || 'A').toUpperCase()}
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuLabel>
              <div className="text-xs text-muted-foreground">{t('signed_in_as')}</div>
              <div className="text-sm font-medium truncate">{email || t('default_admin_name')}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/admin/settings')}>
              <SettingsIcon className="mr-2 h-4 w-4" /> {t('account_settings')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/admin/branding')}>
              <User className="mr-2 h-4 w-4" /> {t('brand_profile')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                resetOnboardingTour();
                router.push('/admin?tour=1');
              }}
            >
              <Search className="mr-2 h-4 w-4" /> {t('show_tour')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
              <LogOut className="mr-2 h-4 w-4" /> {tCommon('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
