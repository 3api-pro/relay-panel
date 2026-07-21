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

/**
 * root-only 审计 payload 字段（上游用量/成本口径，单位 USD）。
 * F5 刻意仅经 root-only 的 channelBalances/balances 端点透出这些数字，channels.list 不含。
 * 审计记录本身在库里保留全量 before/after（供 root 取证、满足"全量审计记 before/after"硬要求）；
 * 非 root 经 GET /api/sites/:slug/audit 读取时，在服务层剥离这些字段——与 canAccessSite 授予
 * viewer 全站可见 / operator 本站可见的口径保持一致（绝不向非 root 泄露上游用量/成本）。
 */
const ROOT_ONLY_PAYLOAD_KEYS = new Set(['quotaUsedBefore', 'quotaUsedAfter']);

/**
 * 非 root 读取审计条目时，从 payload 顶层剥离 root-only 上游用量字段（就地不改库）。
 * 保留 channelId/channelName/action/slug 等可追溯字段。isRoot=true 或无命中原样返回。
 */
export function redactRootOnlyAuditPayload(
  payload: Record<string, unknown> | null,
  isRoot: boolean,
): Record<string, unknown> | null {
  if (isRoot || payload === null) return payload;
  let hit = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (ROOT_ONLY_PAYLOAD_KEYS.has(k)) {
      hit = true;
      continue;
    }
    out[k] = v;
  }
  return hit ? out : payload;
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
