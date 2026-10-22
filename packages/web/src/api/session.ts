import { computed, reactive } from 'vue';
import { get, post } from './client';
import type { Me } from './types';
import { clearWorkspace, restoreWorkspace } from './workspace';

/**
 * 会话 store（简单组合式，非 pinia）：boot 时 GET /api/auth/me 缓存，
 * 路由守卫与 Shell 共用。401 视为未登录，不弹 toast。
 */

interface SessionState {
  user: Me | null;
  workspaceRole: string;
  workspaceName: string;
  /** 是否已完成首次 /api/auth/me 探测（守卫据此避免重复请求） */
  loaded: boolean;
}

const state = reactive<SessionState>({
  user: null,
  workspaceRole: 'owner',
  workspaceName: '',
  loaded: false,
});

let inflight: Promise<Me | null> | null = null;

/** 确保会话已加载（并发去重）；force 时强制重新探测 */
async function ensureLoaded(force = false): Promise<Me | null> {
  if (state.loaded && !force) return state.user;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const me = await get<Me>('/api/auth/me', { silent: true, skipAuthRedirect: true });
      state.user = me;
      try {
        const selected = restoreWorkspace(me.email);
        if (selected && me.role === 'operator') {
          const result = await get<{ workspaces: { ownerId: number; name: string; role: string }[] }>('/api/team/workspaces', { silent: true });
          const workspace = result.workspaces.find(w => w.ownerId === selected);
          if (workspace) { state.workspaceRole = workspace.role; state.workspaceName = workspace.name; }
          else { clearWorkspace(); state.workspaceRole = 'owner'; state.workspaceName = ''; }
        } else { clearWorkspace(); state.workspaceRole = 'owner'; state.workspaceName = ''; }
      } catch { state.workspaceRole = 'reader'; }
    } catch {
      clearWorkspace();
      state.user = null;
    } finally {
      state.loaded = true;
      inflight = null;
    }
    return state.user;
  })();
  return inflight;
}

/** 登录成功后写入（login 响应与 /me 同构） */
function setUser(me: Me): void {
  clearWorkspace();
  state.workspaceRole = 'owner';
  state.workspaceName = '';
  state.user = me;
  state.loaded = true;
}

function clear(): void {
  clearWorkspace();
  state.user = null;
  state.workspaceRole = 'owner';
  state.workspaceName = '';
  state.loaded = true;
}

/** 登出：调后端吊销 session 并清本地态（跳转由调用方负责） */
async function logout(): Promise<void> {
  try {
    await post('/api/auth/logout', undefined, { silent: true });
  } catch {
    // 后端不可达也照常清本地会话
  }
  clear();
}

export const session = {
  state,
  ensureLoaded,
  setUser,
  clear,
  logout,
  /** viewer 角色为只读；Shell 以此 provide('canWrite') */
  canWrite: computed(() => state.user !== null && state.user.role !== 'viewer' && state.workspaceRole !== 'reader'),
  isRoot: computed(() => state.user?.role === 'root'),
};
