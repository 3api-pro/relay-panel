import { PaymentsService, type PaymentsServiceDeps } from './service.js';

/** Reconciliation is read-only at the payment gateway; it never creates a charge or sends mail. */
export function startPaymentReconciliation(deps: PaymentsServiceDeps, intervalMs: number): { stop(): void; tick(): Promise<void> } {
  const service = new PaymentsService(deps);
  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try { await service.reconcile(); }
    catch { console.warn('[payments] reconciliation unavailable; will retry'); }
    finally { running = false; }
  }
  const timer = intervalMs > 0 ? setInterval(() => void tick(), intervalMs) : null;
  timer?.unref();
  return { tick, stop() { if (timer) clearInterval(timer); } };
}
