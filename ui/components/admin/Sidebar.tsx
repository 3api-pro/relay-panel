'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, BarChart3, Package, ShoppingCart, Users,
  Plug, Wallet, Palette, CreditCard, Settings, SlidersHorizontal,
  ChevronDown, ChevronLeft, ChevronRight, Share2, Webhook, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/lib/i18n';

interface NavItem { href: string; labelKey: string; Icon: typeof LayoutDashboard; }
interface NavGroup { id: string; titleKey: string; items: NavItem[]; }

const GROUPS: NavGroup[] = [
  {
    id: 'overview', titleKey: 'overview',
    items: [
      { href: '/admin',       labelKey: 'dashboard', Icon: LayoutDashboard },
      { href: '/admin/stats', labelKey: 'stats',     Icon: BarChart3 },
    ],
  },
  {
    id: 'sales', titleKey: 'sales',
    items: [
      { href: '/admin/plans',     labelKey: 'plans',     Icon: Package },
      { href: '/admin/orders',    labelKey: 'orders',    Icon: ShoppingCart },
      { href: '/admin/users',     labelKey: 'users',     Icon: Users },
      { href: '/admin/affiliate', labelKey: 'affiliate', Icon: Share2 },
    ],
  },
  {
    id: 'upstream', titleKey: 'upstream',
    items: [
      { href: '/admin/channels',  labelKey: 'channels',  Icon: Plug },
      { href: '/admin/wholesale', labelKey: 'wholesale', Icon: Wallet },
    ],
  },
  {
    id: 'settings', titleKey: 'settings',
    items: [
      { href: '/admin/branding',       labelKey: 'branding',       Icon: Palette },
      { href: '/admin/system-setting', labelKey: 'system_setting', Icon: SlidersHorizontal },
      { href: '/admin/webhooks',       labelKey: 'webhooks',       Icon: Webhook },
      { href: '/admin/payment-config', labelKey: 'payment_config', Icon: CreditCard },
      { href: '/admin/settings',       labelKey: 'settings',       Icon: Settings },
    ],
  },
];

const COLLAPSE_KEY  = '3api_admin_sidebar_collapsed';
const GROUP_KEY     = '3api_admin_sidebar_groups';

/** Map nav hrefs → driver.js tour anchor names. */
const TOUR_ANCHORS: Record<string, string> = {
  '/admin/plans':     'sidebar-plans',
  '/admin/channels':  'sidebar-channels',
  '/admin/wholesale': 'sidebar-wholesale',
  '/admin/branding':  'sidebar-branding',
};

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname() || '';
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    overview: true, sales: true, upstream: true, settings: true,
  });
  const tGroups = useTranslations('admin.sidebar.groups');
  const tItems = useTranslations('admin.sidebar.items');
  const t = useTranslations('admin.sidebar');

  // Hydrate state
  useEffect(() => {
    try {
      const c = localStorage.getItem(COLLAPSE_KEY);
      if (c === '1') setCollapsed(true);
      const raw = localStorage.getItem(GROUP_KEY);
      if (raw) setOpenGroups((g) => ({ ...g, ...JSON.parse(raw) }));
    } catch {}
  }, []);

  function toggleCollapse() {
    setCollapsed((v) => {
      try { localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1'); } catch {}
      return !v;
    });
  }

  function toggleGroup(id: string) {
    setOpenGroups((g) => {
      const n = { ...g, [id]: !g[id] };
      try { localStorage.setItem(GROUP_KEY, JSON.stringify(n)); } catch {}
      return n;
    });
  }

  function isActive(href: string) {
    if (href === '/admin') return pathname === '/admin' || pathname === '/admin/';
    return pathname.startsWith(href);
  }

  return (
    <>
      {/* Mobile backdrop — appears only when drawer is open on <md screens */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          'bg-card border-r border-border min-h-screen flex flex-col transition-[width,transform] duration-200',
          // Desktop: always in-flow shrink-0; width depends on collapsed.
          'md:shrink-0 md:translate-x-0',
          collapsed ? 'md:w-16' : 'md:w-60',
          // Mobile: fixed off-canvas drawer at fixed width 240px, slides in.
          'fixed inset-y-0 left-0 z-40 w-60',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
        data-collapsed={collapsed ? 'true' : 'false'}
      >
      <div className="h-14 px-4 border-b border-border flex items-center justify-between gap-2">
        <Link href="/admin" className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shrink-0">3</div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">{t('brand_title')}</div>
              <div className="text-[10px] text-muted-foreground truncate">{t('brand_sub')}</div>
            </div>
          )}
        </Link>
        {/* Mobile close button — drawer only, hidden on md+ */}
        <button
          type="button"
          onClick={onMobileClose}
          aria-label={t('collapse')}
          className="md:hidden p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-2">
        {GROUPS.map((g) => (
          <div key={g.id}>
            {!collapsed && (
              <button
                onClick={() => toggleGroup(g.id)}
                className="w-full px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground flex items-center justify-between hover:text-foreground transition-colors"
              >
                <span>{tGroups(g.titleKey)}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform', !openGroups[g.id] && '-rotate-90')} />
              </button>
            )}
            {(collapsed || openGroups[g.id]) && (
              <div className="space-y-0.5 mt-1">
                {g.items.map((it) => {
                  const active = isActive(it.href);
                  const label = tItems(it.labelKey);
                  return (
                    <Link
                      key={it.href}
                      href={it.href}
                      title={collapsed ? label : undefined}
                      data-tour={TOUR_ANCHORS[it.href]}
                      className={cn(
                        'flex items-center gap-3 rounded-md text-sm transition-colors',
                        collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
                        active
                          ? 'bg-primary/10 text-primary border-l-2 border-primary -ml-[2px] pl-[calc(0.75rem-2px)]'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <it.Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2 hidden md:block">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapse}
          className="w-full justify-center text-muted-foreground"
          title={collapsed ? t('expand') : t('collapse')}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span className="ml-2 text-xs">{t('collapse_short')}</span>}
        </Button>
      </div>
      </aside>
    </>
  );
}
