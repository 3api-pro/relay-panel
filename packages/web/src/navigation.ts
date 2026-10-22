import type { OperatorRole } from './api/types';

/** One policy for navigation visibility and direct-link access. API authorization remains authoritative. */
export interface NavigationItem {
  to: string;
  key: string;
  icon: string;
  roles?: readonly OperatorRole[];
}
export interface NavigationGroup {
  key: string;
  items: NavigationItem[];
}

const item = (to: string, key: string, icon: string, roles?: readonly OperatorRole[]): NavigationItem =>
  ({ to, key, icon, ...(roles ? { roles } : {}) });

export function navigationFor(role: OperatorRole): NavigationGroup[] {
  const root = role === 'root';
  const groups: NavigationGroup[] = [
    { key: 'groupWorkspace', items: [
      item('/', 'overview', 'overview'),
      item('/sites', root ? 'allSites' : 'mySites', 'sites'),
      item('/self-deploy', 'localApps', 'sites', ['root', 'operator']),
      item('/batch', 'batch', 'batch', ['root', 'operator']),
      ...(!root ? [item('/marketplace', 'marketplace', 'marketplace')] : []),
    ] },
    { key: 'groupServices', items: [
      item('/services', 'services', 'overview'),
      item('/knowledge', 'knowledge', 'help'),
      item('/collaboration', 'collaboration', 'operators', ['root', 'operator']),
    ] },
    { key: 'groupMonitoring', items: [
      item('/alerts', 'alerts', 'alerts'),
      item('/jobs', 'jobs', 'jobs'),
    ] },
    { key: root ? 'groupOperations' : 'groupFinance', items: [
      item('/finance', 'finance', 'finance'),
      item('/budgets', 'budgets', 'finance'),
      item('/finance-access', 'financeAccess', 'finance', ['root', 'operator']),
      ...(root ? [
        item('/admin/finance-review', 'financeReview', 'finance'),
        item('/admin/reconciliation', 'reconciliation', 'finance'),
        item('/customers', 'customerInsights', 'customers'),
        item('/upstream', 'upstream', 'upstream'),
        item('/risk', 'risk', 'risk'),
      ] : []),
      item('/ledger', 'ledger', 'ledger'),
      ...(!root ? [item('/billing', 'myBilling', 'billing', ['operator'])] : []),
    ] },
    ...(root ? [{ key: 'groupAdministration', items: [
      item('/operators', 'tenantAccess', 'operators'),
      item('/admin/billing', 'platformBilling', 'billing'),
      item('/admin/aftercare', 'aftercare', 'billing'),
      item('/support', 'tickets', 'help'),
      item('/admin/marketplace', 'marketplaceManagement', 'marketplace'),
      item('/admin/settings', 'platformSettings', 'settings'),
      item('/admin/operations', 'operations', 'settings'),
    ] }] : []),
    { key: 'groupAccount', items: [
      item('/settings', 'accountSettings', 'account'),
      item('/team', 'team', 'operators', ['root', 'operator']),
      item('/notifications', 'notifications', 'alerts'),
      ...(!root ? [item('/billing/aftercare', 'aftercare', 'billing', ['operator']), item('/support', 'tickets', 'help', ['operator'])] : []),
      item('/help', 'help', 'help'),
    ] },
  ];
  return groups.map(g => ({ ...g, items: g.items.filter(i => !i.roles || i.roles.includes(role)) }))
    .filter(g => g.items.length > 0);
}

const ADMIN_PATHS = ['/admin', '/operators', '/upstream', '/risk', '/customers'];
const matches = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

export function canVisit(role: OperatorRole, path: string): boolean {
  if (ADMIN_PATHS.some(prefix => matches(path, prefix))) return role === 'root';
  if (matches(path, '/batch')) return role !== 'viewer';
  return true;
}

/** Preserve bookmarks while moving the owner's management surfaces out of personal billing. */
export function canonicalPath(role: OperatorRole, path: string): string {
  if (role === 'root' && path === '/billing') return '/admin/billing';
  if (role === 'root' && path === '/marketplace') return '/admin/marketplace';
  return path;
}
