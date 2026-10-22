import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/ui/toast', () => ({ toast: { error: vi.fn() } }));

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('localStorage', storage());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('tab-local workspace request context', () => {
  it('keeps two open tabs isolated, including legacy shared storage and in-flight forms', async () => {
    const firstStorage = sessionStorage, first = await import('../src/api/workspace');
    first.selectWorkspace('member@example.test', 10);
    expect(first.workspaceHeaders()).toEqual({});
    expect(first.restoreWorkspace('member@example.test')).toBe(10);
    vi.resetModules();
    const secondStorage = storage(); vi.stubGlobal('sessionStorage', secondStorage);
    const second = await import('../src/api/workspace');
    expect(second.restoreWorkspace('member@example.test')).toBeNull();
    second.selectWorkspace('member@example.test', 20);
    second.restoreWorkspace('member@example.test');
    localStorage.setItem('rp-workspace', '999');
    expect(first.workspaceHeaders()).toEqual({ 'x-workspace-id': '10' });
    expect(second.workspaceHeaders()).toEqual({ 'x-workspace-id': '20' });
    second.selectWorkspace('member@example.test', 30);
    expect(second.workspaceHeaders()).toEqual({ 'x-workspace-id': '20' });
    vi.stubGlobal('sessionStorage', firstStorage);
    expect(first.restoreWorkspace('member@example.test')).toBe(10);
  });

  it('discards selections from another account and clears the active context on logout', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('first@example.test', 10);
    expect(workspace.restoreWorkspace('second@example.test')).toBeNull();
    workspace.selectWorkspace('second@example.test', 20);
    workspace.restoreWorkspace('second@example.test');
    workspace.clearWorkspace();
    expect(workspace.workspaceHeaders()).toEqual({});
    expect(workspace.restoreWorkspace('second@example.test')).toBeNull();
  });

  it('ignores corrupt storage and rejects switching when the browser cannot persist it', async () => {
    const workspace = await import('../src/api/workspace');
    for (const raw of ['not json', 'null', '{}', '{"account":"member@example.test","ownerId":-1}', '{"account":"member@example.test","ownerId":"10"}']) {
      sessionStorage.setItem('rp-workspace-v2', raw);
      expect(workspace.restoreWorkspace('member@example.test')).toBeNull();
    }
    workspace.selectWorkspace('member@example.test', 10);
    workspace.restoreWorkspace('member@example.test');
    vi.stubGlobal('sessionStorage', { setItem() { throw new Error('Storage disabled'); } });
    expect(() => workspace.selectWorkspace('member@example.test', 20)).toThrow('Storage disabled');
    expect(workspace.workspaceHeaders()).toEqual({ 'x-workspace-id': '10' });
  });

  it('uses the displayed scope for JSON writes and file exports even after shared storage changes', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('member@example.test', 10);
    workspace.restoreWorkspace('member@example.test');
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"ok":true}')).mockResolvedValueOnce(new Response('team,amount\nA,2.00'));
    vi.stubGlobal('fetch', fetchMock);
    const client = await import('../src/api/client');
    localStorage.setItem('rp-workspace', '20');
    workspace.selectWorkspace('member@example.test', 30);
    await client.post('/api/sites/adopt', { label: 'Team A' });
    expect(await (await client.getBlob('/api/services/budgets/1/report.csv')).text()).toContain('A,2.00');
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.credentials).toBe('same-origin');
      expect(options.headers['x-workspace-id']).toBe('10');
    }
  });

  it('handles an expired export session and denied exports without downloading an error body', async () => {
    const client = await import('../src/api/client'), redirect = vi.fn();
    client.setUnauthorizedHandler(redirect);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"message":"会话已过期"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"message":"工作区不可访问"}', { status: 403 })));
    await expect(client.getBlob('/api/services/quality.csv', { silent: true })).rejects.toMatchObject({ status: 401 });
    expect(redirect).toHaveBeenCalledOnce();
    await expect(client.getBlob('/api/services/quality.csv', { silent: true })).rejects.toMatchObject({ status: 403, message: '工作区不可访问' });
    expect(redirect).toHaveBeenCalledOnce();
  });
});

describe('workspace session bootstrap', () => {
  it('restores a validated membership and uses its reader role for the UI', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('member@example.test', 10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ email: 'member@example.test', role: 'operator' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{ ownerId: 10, name: 'Team A', role: 'reader' }] }))));
    const { session } = await import('../src/api/session');
    await session.ensureLoaded();
    expect(session.state.workspaceName).toBe('Team A');
    expect(session.canWrite.value).toBe(false);
    expect(workspace.workspaceHeaders()).toEqual({ 'x-workspace-id': '10' });
    session.clear();
    expect(workspace.workspaceHeaders()).toEqual({});
  });

  it('removes revoked memberships before rendering personal scope', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('member@example.test', 10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ email: 'member@example.test', role: 'operator' })))
      .mockResolvedValueOnce(new Response('{"workspaces":[]}')));
    const { session } = await import('../src/api/session');
    await session.ensureLoaded();
    expect(session.state.workspaceRole).toBe('owner');
    expect(session.state.workspaceName).toBe('');
    expect(workspace.workspaceHeaders()).toEqual({});
  });

  it('keeps the selected scope read-only on membership lookup failure instead of silently switching', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('member@example.test', 10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ email: 'member@example.test', role: 'operator' })))
      .mockRejectedValueOnce(new Error('Network failed')));
    const { session } = await import('../src/api/session');
    await session.ensureLoaded();
    expect(session.canWrite.value).toBe(false);
    expect(workspace.workspaceHeaders()).toEqual({ 'x-workspace-id': '10' });
  });

  it('clears team scope for administrators and for a new login', async () => {
    const workspace = await import('../src/api/workspace');
    workspace.selectWorkspace('admin@example.test', 10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ email: 'admin@example.test', role: 'root' }))));
    const { session } = await import('../src/api/session');
    await session.ensureLoaded();
    expect(workspace.workspaceHeaders()).toEqual({});
    workspace.selectWorkspace('admin@example.test', 20);
    workspace.restoreWorkspace('admin@example.test');
    session.setUser({ email: 'member@example.test', displayName: null, role: 'operator', signupMode: 'closed' });
    expect(workspace.workspaceHeaders()).toEqual({});
  });
});
