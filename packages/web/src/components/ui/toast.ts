import { reactive, readonly } from 'vue';

/**
 * 组合式 toast：模块级单例状态，任何模块（含非组件的 api/client.ts）可直接调用。
 * Toast.vue 是渲染宿主，App.vue 挂一次。
 */

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const state = reactive<{ items: ToastItem[] }>({ items: [] });

let nextId = 1;

const DURATION: Record<ToastTone, number> = {
  info: 3000,
  success: 3000,
  error: 5000,
};

function push(tone: ToastTone, message: string): number {
  const id = nextId++;
  // 同文案去重：连续同错误只保留一条，避免轮询失败刷屏
  if (state.items.some((t) => t.message === message && t.tone === tone)) return id;
  state.items.push({ id, tone, message });
  if (state.items.length > 5) state.items.shift();
  window.setTimeout(() => dismiss(id), DURATION[tone]);
  return id;
}

function dismiss(id: number): void {
  const i = state.items.findIndex((t) => t.id === id);
  if (i >= 0) state.items.splice(i, 1);
}

export const toast = {
  info: (message: string) => push('info', message),
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  dismiss,
};

/** 组件内用法：const { toasts, success, error, info, dismiss } = useToast() */
export function useToast() {
  return {
    toasts: readonly(state).items,
    info: toast.info,
    success: toast.success,
    error: toast.error,
    dismiss,
  };
}
