import { describe, expect, it } from 'vitest';
import { canVisit, canonicalPath, navigationFor } from '../src/navigation';

describe('workspace access', () => {
  it('keeps platform administration out of operator and observer workspaces, including direct links', () => {
    for (const role of ['operator', 'viewer'] as const) {
      const links = navigationFor(role).flatMap(g => g.items.map(i => i.to));
      for (const path of ['/admin/finance-review', '/admin/settings', '/admin/billing', '/admin/marketplace', '/operators', '/upstream', '/risk', '/customers']) {
        expect(links).not.toContain(path);
        expect(canVisit(role, path)).toBe(false);
        expect(canVisit(role, `${path}/detail`)).toBe(false);
      }
      expect(links).toContain('/settings');
    }
  });
  it('separates personal account security from owner billing and preserves bookmarked URLs', () => {
    const links = navigationFor('root').flatMap(g => g.items.map(i => i.to));
    expect(links).toContain('/settings');
    expect(links).toContain('/admin/settings');
    expect(links).toContain('/admin/billing');
    expect(links).not.toContain('/billing');
    expect(canonicalPath('root', '/billing')).toBe('/admin/billing');
    expect(canonicalPath('operator', '/billing')).toBe('/billing');
    expect(canonicalPath('root', '/marketplace')).toBe('/admin/marketplace');
    expect(canVisit('viewer', '/batch')).toBe(false);
  });
});
