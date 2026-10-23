export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'installing' | 'backing_up' | 'restarting' | 'checking' | 'succeeded' | 'failed';
export interface UpdateStatus {
  supported: boolean;
  reason: string | null;
  phase: UpdatePhase;
  id: string | null;
  from: string | null;
  target: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  backupId: number | null;
}
export interface PanelUpdater {
  status(): Promise<UpdateStatus>;
  start(target: string, actor: string): Promise<UpdateStatus>;
}
export const updateActive = (phase: UpdatePhase): boolean => !['idle', 'succeeded', 'failed'].includes(phase);
export function initialUpdateStatus(supported: boolean, reason: string | null = null): UpdateStatus {
  return { supported, reason, phase: 'idle', id: null, from: null, target: null, startedAt: null, completedAt: null, error: null, backupId: null };
}
