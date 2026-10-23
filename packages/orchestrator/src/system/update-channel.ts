import { randomUUID } from 'node:crypto';
import { ApiError } from '../auth/rbac.js';
import { initialUpdateStatus, type PanelUpdater, type UpdateStatus } from './update-types.js';

export interface UpdateMessage { channel: 'panel-update-v1'; id: string; method?: string; args?: unknown; result?: unknown; error?: string }
export function isUpdateMessage(value: unknown): value is UpdateMessage {
  return !!value && typeof value === 'object' && (value as UpdateMessage).channel === 'panel-update-v1' && typeof (value as UpdateMessage).id === 'string';
}
export function createUpdateChannel(peer: NodeJS.EventEmitter & { send?: ((message: UpdateMessage, callback: (error: Error | null) => void) => unknown) | undefined }, handler: (method: string, args: unknown) => Promise<unknown>) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listener = (value: unknown): void => {
    if (!isUpdateMessage(value)) return;
    if (value.method) {
      void handler(value.method, value.args).then(result => peer.send?.({ channel: 'panel-update-v1', id: value.id, result }, () => {}), err => peer.send?.({ channel: 'panel-update-v1', id: value.id, error: err instanceof Error ? err.message : '更新执行失败' }, () => {})).catch(() => undefined);
    } else {
      const call = pending.get(value.id); if (!call) return;
      pending.delete(value.id); clearTimeout(call.timer);
      if (value.error) call.reject(new Error(value.error)); else call.resolve(value.result);
    }
  };
  peer.on('message', listener);
  function close(): void {
    peer.removeListener('message', listener);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('更新进程连接中断')); }
    pending.clear();
  }
  peer.once('disconnect', close);
  return {
    close,
    call<T>(method: string, args?: unknown, timeout = 15_000): Promise<T> {
      return new Promise((resolve, reject) => {
        const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('更新进程响应超时')); }, timeout);
        pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        try { peer.send?.({ channel: 'panel-update-v1', id, method, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('更新进程连接中断')); } }); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('更新进程连接中断')); }
      });
    },
  };
}

export function updaterFromChannel(channel: ReturnType<typeof createUpdateChannel> | null): PanelUpdater {
  return {
    async status() { return channel ? channel.call<UpdateStatus>('status') : initialUpdateStatus(false, '当前启动方式尚未启用一键更新，请先使用管理更新的启动程序部署此版本'); },
    async start(target, actor) {
      if (!channel) throw new ApiError(409, '当前启动方式不支持一键更新');
      try { return await channel.call<UpdateStatus>('start', { target, actor }); }
      catch (err) { throw new ApiError(409, err instanceof Error ? err.message : '无法启动更新'); }
    },
  };
}
