// Keep the displayed workspace and outgoing requests bound to this page instance.
// localStorage is shared by tabs and must never determine a request's tenant.
const storageKey = 'rp-workspace-v2';
let activeOwnerId: number | null = null;

export function workspaceHeaders(): Record<string, string> {
  return activeOwnerId === null ? {} : { 'x-workspace-id': String(activeOwnerId) };
}

export function clearWorkspace(): void {
  activeOwnerId = null;
  try { sessionStorage.removeItem(storageKey); } catch { /* Personal workspace still works without storage. */ }
}

/** Called during session bootstrap, before rendering any workspace views. */
export function restoreWorkspace(account: string): number | null {
  activeOwnerId = null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { account?: unknown; ownerId?: unknown } | null;
    if (saved?.account !== account || typeof saved.ownerId !== 'number' || !Number.isSafeInteger(saved.ownerId) || saved.ownerId <= 0) {
      clearWorkspace();
      return null;
    }
    activeOwnerId = saved.ownerId;
  } catch { clearWorkspace(); }
  return activeOwnerId;
}

/** Save for the next page load; pending forms keep their current request context. */
export function selectWorkspace(account: string, ownerId: number): void {
  if (!account || !Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error('Invalid workspace');
  // Do not navigate when storage is unavailable: that would silently select personal scope.
  sessionStorage.setItem(storageKey, JSON.stringify({ account, ownerId }));
}
