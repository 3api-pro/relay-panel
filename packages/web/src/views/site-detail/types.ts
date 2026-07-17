/**
 * SiteDetailView 本地类型（仅本视图与其子组件使用；不进 api/types.ts 以避免与并行视图追加冲突）。
 * 复用 api/types.ts 中已冻结的 SiteView / UsageBucket。
 */
import type { UsageBucket } from '../../api/types';

/** GET /api/sites/:slug/usage → 用量桶集合 */
export interface SiteUsageResponse {
  buckets: UsageBucket[];
  costUnit: string;
}

/** 站点渠道行（GET /api/sites/:slug/channels；apiKey 出口恒 '<redacted>'） */
export interface SiteChannel {
  id: number | string;
  name: string;
  protocol: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  apiKey: string;
  groups?: (number | string)[];
  priority?: number;
  weight?: number;
}
export interface SiteChannelsResponse {
  channels: SiteChannel[];
}

/** 新建渠道入参（POST /api/sites/:slug/channels） */
export interface ChannelSpec {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  priority?: number;
}
/** POST/PATCH channels 响应 */
export interface ChannelMutationResponse {
  channel: SiteChannel;
}

/** 渠道连通性测试结果（POST channels/:id/test） */
export interface ChannelTestResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string;
}
export interface ChannelTestResponse {
  result: ChannelTestResult;
}

/** 站点用户行（GET /api/sites/:slug/users） */
export interface SiteUser {
  id: number | string;
  email?: string;
  username?: string;
  role: string;
  balance?: number;
  status: string;
}
export interface SiteUsersResponse {
  users: SiteUser[];
}

/** 站点品牌设置（GET/PUT /api/sites/:slug/branding，字段随引擎可选） */
export interface SiteBranding {
  siteName?: string;
  logoUrl?: string;
  announcement?: string;
}
export interface SiteBrandingResponse {
  branding: SiteBranding;
}

/** 站点域名（GET/POST/DELETE /api/sites/:slug/domains） */
export interface SiteDomainsResponse {
  domains: string[];
}

/** 站点审计事件（GET /api/sites/:slug/audit） */
export interface SiteAuditEvent {
  id: number | string;
  actor: string;
  action: string;
  ok: boolean;
  error?: string | null;
  payload?: unknown;
  createdAt: string;
}
export interface SiteAuditResponse {
  events: SiteAuditEvent[];
}

/** 任务步骤（GET /api/jobs） */
export interface JobStep {
  step: string;
  status: string;
  detail?: string;
  at: string;
}
/** 任务行（GET /api/jobs?slug=） */
export interface JobView {
  id: number;
  kind: string;
  siteId?: number;
  slug: string;
  status: string;
  steps: JobStep[];
  error?: string | null;
  createdBy: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}
export interface JobsResponse {
  jobs: JobView[];
}
