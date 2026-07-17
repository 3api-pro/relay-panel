import type { ChannelSpec, EngineAdapter } from '@relay-panel/adapter-core';
import { Sub2apiAdapter } from '@relay-panel/adapter-sub2api';
import { entryToInstance, makeCredentialStore, type RegistryFile } from '../registry.js';
import type { ChannelTemplate, GrantInput, GrantRecord } from './types.js';

const adapters: Record<string, EngineAdapter> = {
  sub2api: new Sub2apiAdapter(),
};

/** 从模板 + 授权输入构造引擎无关的 ChannelSpec */
export function buildChannelSpec(tpl: ChannelTemplate, input: GrantInput): ChannelSpec {
  if (tpl.source === 'byo') {
    if (!input.byo) throw new Error(`template "${tpl.key}" is byo — baseUrl+apiKey required`);
  } else if (tpl.source === 'managed') {
    // managed 模式需向计量网关申请 per-site key —— 计量网关不在本仓库，此处显式拒绝
    // 直到编排器接入网关（P2.2 后续 / 私有部署提供）。
    throw new Error(`template "${tpl.key}" is managed — metering gateway integration not wired in this build`);
  }
  const byo = input.byo!;
  return {
    name: input.channelName ?? tpl.title,
    protocol: tpl.protocol,
    baseUrl: byo.baseUrl,
    apiKey: byo.apiKey,
    models: tpl.models,
    ...(tpl.modelMapping ? { modelMapping: tpl.modelMapping } : {}),
    ...(input.groupIds ? { groups: input.groupIds } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(tpl.raw ? { raw: tpl.raw } : {}),
  };
}

/** 启用：把模板注入目标站，返回授权记录（含站内渠道 id，供撤销/分账） */
export async function applyGrant(
  reg: RegistryFile,
  templates: ChannelTemplate[],
  input: GrantInput,
  now: string,
): Promise<GrantRecord> {
  const tpl = templates.find((t) => t.key === input.templateKey);
  if (!tpl) throw new Error(`unknown template: ${input.templateKey}`);
  const entry = reg.sites.find((s) => s.slug === input.siteSlug);
  if (!entry) throw new Error(`unknown site: ${input.siteSlug}`);
  const adapter = adapters[entry.engine];
  if (!adapter) throw new Error(`no adapter for engine: ${entry.engine}`);

  const spec = buildChannelSpec(tpl, input);
  const client = await adapter.connect(entryToInstance(entry), makeCredentialStore(reg));
  const created = await client.channels.create(spec);

  return {
    templateKey: tpl.key,
    siteSlug: input.siteSlug,
    engineChannelId: created.id,
    meterKeyRef: null, // byo 模式无计量 key
    createdAt: now,
  };
}

/** 撤销：从站内删除该授权注入的渠道 */
export async function revokeGrant(reg: RegistryFile, grant: GrantRecord): Promise<void> {
  const entry = reg.sites.find((s) => s.slug === grant.siteSlug);
  if (!entry) throw new Error(`unknown site: ${grant.siteSlug}`);
  const adapter = adapters[entry.engine];
  if (!adapter) throw new Error(`no adapter for engine: ${entry.engine}`);
  const client = await adapter.connect(entryToInstance(entry), makeCredentialStore(reg));
  await client.channels.remove(grant.engineChannelId);
}
