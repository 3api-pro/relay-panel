import type { ChannelSpec } from '@relay-panel/adapter-core';

/**
 * 渠道市场：把"上游渠道产品"抽象成模板，站长一键启用即注入到目标站。
 *
 * 商业定位（见 docs/ARCHITECTURE.md §5）：
 * - 自部署开源版里，市场是**可关闭插件**，模板可指向站长自己的上游或推荐上游。
 * - 托管/推荐场景里，模板可指向我方计量网关签发的 per-site key，用量回传分账。
 *   计量网关本身不在本仓库（闭源、独立部署）——本层只负责"注入正确的 channel"。
 */
export interface ChannelTemplate {
  /** 稳定唯一键，用于授权记账 */
  key: string;
  /** 展示名（对站长可见，不得暴露上游供应商真名） */
  title: string;
  description?: string;
  protocol: ChannelSpec['protocol'];
  /** 支持的模型（对外模型名） */
  models: string[];
  /** 建议倍率（仅提示，最终由站长/站点分组决定） */
  suggestedRatio?: number;
  /** 模型重定向（对外名 -> 上游名） */
  modelMapping?: Record<string, string>;
  /**
   * 上游接入参数来源：
   *  - 'byo'   : 站长自带（授权时传入 baseUrl+apiKey）
   *  - 'managed': 我方计量网关签发（授权时由编排器向全局网关申请 per-site key）
   */
  source: 'byo' | 'managed';
  /** managed 模式下计量网关的注入端点（DB 化后未持久化——统一走全局网关配置，字段仅兼容保留） */
  managedGatewayUrl?: string;
  /** byo 授权参数的 JSON Schema 描述（前端表单渲染提示用） */
  paramsSchema?: Record<string, unknown>;
  /** 是否可被启用（DB channel_templates.enabled 同义） */
  enabled?: boolean;
  /** 引擎私有字段透传（如 sub2api account extra） */
  raw?: Record<string, unknown>;
}

/** 授权：某站启用某模板的输入 */
export interface GrantInput {
  siteSlug: string;
  templateKey: string;
  /** 落在目标站内的渠道名（缺省用模板 title） */
  channelName?: string;
  /** byo 模式必填 */
  byo?: { baseUrl: string; apiKey: string };
  /** 注入到站内哪些分组（引擎分组 id） */
  groupIds?: string[];
  priority?: number;
}

/**
 * 授权产物（registry 时代的旧形状，保留仅为类型兼容）。
 * DB 化后授权记录以 channel_grants 表为准，API 视图见 grant.ts 的 GrantView。
 */
export interface GrantRecord {
  templateKey: string;
  siteSlug: string;
  engineChannelId: string;
  /** managed 模式下的计量 key 引用（凭据库），byo 模式为 null */
  meterKeyRef: string | null;
  createdAt: string;
}
