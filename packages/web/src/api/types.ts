/**
 * 后端 API 响应类型（与 orchestrator 路由契约同构，前端手工维护）。
 * 实时字段（ok/latencyMs/usage24h 等）在站点探测失败或后端旧版本时可能缺失，
 * 视图层一律可选访问。
 */

export type OperatorRole = 'root' | 'operator' | 'viewer';

/** GET /api/auth/me、POST /api/auth/login 响应 */
export interface Me {
  email: string;
  displayName: string | null;
  role: OperatorRole;
  signupMode: 'closed' | 'invite' | 'open';
}

/** 站点 24h 用量摘要（G1 快照聚合提供） */
export interface SiteUsage24h {
  requests?: number;
  tokens?: number;
  cost?: number;
  costUnit?: string;
}

/** GET /api/sites 列表项（DB 字段 + G1 实时探测字段，后者全部可选） */
export interface SiteView {
  id: number;
  slug: string;
  label: string;
  engine: string;
  version: string;
  status: string;
  managed: 'compose' | 'external' | string;
  hostPort: number;
  baseUrl: string;
  domains: string[];
  notes?: string | null;
  operatorId?: number;
  operatorEmail?: string;
  createdAt: string;
  updatedAt?: string;
  /** ---- 实时字段（G1）---- */
  ok?: boolean;
  latencyMs?: number;
  groups?: number;
  accounts?: number;
  usage24h?: SiteUsage24h;
  branding?: { siteName?: string; logoUrl?: string };
  error?: string;
  activeJob?: { id: number; kind: string; status: string } | null;
}

export interface SitesResponse {
  sites: SiteView[];
  generatedAt: string;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** GET /api/alerts 行（G3） */
export interface AlertView {
  id: number;
  kind: string;
  siteId: number | null;
  siteSlug?: string | null;
  severity: AlertSeverity | string;
  title: string;
  detail?: string | null;
  status: 'open' | 'resolved' | string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string | null;
}

export interface AlertsResponse {
  alerts: AlertView[];
}

/** GET /api/sites/:slug/usage 桶（G1） */
export interface UsageBucket {
  date: string;
  requests: number;
  tokens: number;
  cost: number;
}
