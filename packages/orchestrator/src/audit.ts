import type { Db } from './db/client.js';
import { auditEvents } from './db/schema.js';

/** key 命中即整值替换（含嵌套对象/数组整体丢弃），宁可多杀不可漏 */
const SENSITIVE_KEY_RE = /key|secret|password|token|credential|apikey/i;

/**
 * 深拷贝并把敏感 key 的值替换为 '<redacted>'。
 * 所有审计 payload、job step detail 入库前必须过这里。
 */
export function redact<T>(value: T): T {
  return redactInner(value) as T;
}

function redactInner(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactInner(v));
  if (value !== null && typeof value === 'object') {
    // 非 plain object（Date 等）原样保留，JSON 序列化时自然收敛
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '<redacted>' : redactInner(v);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  siteId?: number | null;
  actor: string;
  action: string;
  payload?: Record<string, unknown>;
  ok: boolean;
  error?: string | null;
}

/** 所有写路由必须调用；payload 强制过 redact */
export async function writeAudit(db: Db, event: AuditInput): Promise<void> {
  await db.orm.insert(auditEvents).values({
    ...(event.siteId !== undefined && event.siteId !== null ? { siteId: event.siteId } : {}),
    actor: event.actor,
    action: event.action,
    ...(event.payload !== undefined ? { payload: redact(event.payload) } : {}),
    ok: event.ok,
    ...(event.error !== undefined && event.error !== null ? { error: event.error } : {}),
  });
}
