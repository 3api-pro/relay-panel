'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, BarChart3, Package, ShoppingCart, Users,
  Plug, Wallet, Palette, CreditCard, Settings,
  ChevronDown, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface NavItem { href: string; label: string; Icon: typeof LayoutDashboard; }
interface NavGroup { id: string; title: string; items: NavItem[]; }

const GROUPS: NavGroup[] = [
  {
    id: 'overview', title: '概览',
    items: [
      { href: '/admin',       label: '总览',  Icon: LayoutDashboard },
      { href: '/admin/stats', label: '数据', Icon: BarChart3 },
    ],
  },
  {
    id: 'sales', title: '销售',
    items: [
      { href: '/admin/plans',  label: '套餐管理', Icon: Package },
      { href: '/admin/orders', label: '订单',     Icon: ShoppingCart },
      { href: '/admin/users',  label: '终端用户', Icon: Users },
    ],
  },
  {
    id: 'upstream', title: '上游',
    items: [
      { href: '/admin/channels',  label: '上游 Channel', Icon: Plug },
      { href: '/admin/wholesale', label: '批发余额',    Icon: Wallet },
    ],
  },
  {
    id: 'settings', title: '设置',
    items: [
      { href: '/admin/branding',       label: '品牌',     Icon: Palette },
      { href: '/admin/payment-config', label: '收款配置', Icon: CreditCard },
      { href: '/admin/settings',       label: '账号设置', Icon: Settings },
    ],
  },
];

const COLLAPSE_KEY  = '3api_admin_sidebar_collapsed';
const GROUP_KEY     = '3api_admin_sidebar_groups';

export function Sidebar() {
  const pathname = usePathname() || '';
  const [collapsed, setCollapsed] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    overview: true, sales: true, upstream: true, settings: true,
  });

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
    <aside
      className={cn(
        'shrink-0 bg-card border-r border-border min-h-screen flex flex-col transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="h-14 px-4 border-b border-border flex items-center">
        <Link href="/admin" className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm shrink-0">3</div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">3API Admin</div>
              <div className="text-[10px] text-muted-foreground truncate">站长后台</div>
            </div>
          )}
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-2">
        {GROUPS.map((g) => (
          <div key={g.id}>
            {!collapsed && (
              <button
                onClick={() => toggleGroup(g.id)}
                className="w-full px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground flex items-center justify-between hover:text-foreground transition-colors"
              >
                <span>{g.title}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform', !openGroups[g.id] && '-rotate-90')} />
              </button>
            )}
            {(collapsed || openGroups[g.id]) && (
              <div className="space-y-0.5 mt-1">
                {g.items.map((it) => {
                  const active = isActive(it.href);
                  return (
                    <Link
                      key={it.href}
                      href={it.href}
                      title={collapsed ? it.label : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-md text-sm transition-colors',
                        collapsed ? 'justify-center px-2 py-2' : 'px-3 py-2',
                        active
                          ? 'bg-primary/10 text-primary border-l-2 border-primary -ml-[2px] pl-[calc(0.75rem-2px)]'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <it.Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
                      {!collapsed && <span className="truncate">{it.label}</span>}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapse}
          className="w-full justify-center text-muted-foreground"
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          {!collapsed && <span className="ml-2 text-xs">收起</span>}
        </Button>
      </div>
    </aside>
  );
}
