import { Sub2apiAdapter } from '@relay-panel/adapter-sub2api';
import type { EngineAdapter } from '@relay-panel/adapter-core';
import { entryToInstance, makeCredentialStore, type RegistryFile } from './registry.js';

const adapters: Record<string, EngineAdapter> = {
  sub2api: new Sub2apiAdapter(),
};

export interface SiteCard {
  slug: string;
  label: string;
  engine: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  groups?: number;
  accounts?: { total: number; active: number };
  usage24h?: { requests: number; tokens: number; cost: number };
  branding?: string;
}

/** 单站聚合快照（全只读）。任一子调用失败降级为 error 卡片，不影响其它站。 */
export async function siteSnapshot(reg: RegistryFile, slug: string): Promise<SiteCard> {
  const entry = reg.sites.find((s) => s.slug === slug);
  if (!entry) return { slug, label: slug, engine: '?', ok: false, error: 'not in registry' };

  const adapter = adapters[entry.engine];
  if (!adapter) return { slug, label: entry.label, engine: entry.engine, ok: false, error: 'no adapter' };

  const inst = entryToInstance(entry);
  const health = await adapter.health(inst);
  if (!health.ok) {
    return {
      slug,
      label: entry.label,
      engine: entry.engine,
      ok: false,
      ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
      error: health.detail ?? 'unhealthy',
    };
  }

  try {
    const store = makeCredentialStore(reg);
    const client = await adapter.connect(inst, store);
    const now = new Date();
    const [groups, channels, usage, branding] = await Promise.all([
      client.groups.list(),
      client.channels.list(),
      client.stats.usage(new Date(now.getTime() - 86400000), now),
      client.settings.getBranding(),
    ]);
    return {
      slug,
      label: entry.label,
      engine: entry.engine,
      ok: true,
      ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
      groups: groups.length,
      accounts: { total: channels.length, active: channels.filter((c) => c.enabled).length },
      usage24h: {
        requests: usage.requests,
        tokens: usage.promptTokens + usage.completionTokens,
        cost: usage.cost,
      },
      branding: branding.siteName,
    };
  } catch (e) {
    return {
      slug,
      label: entry.label,
      engine: entry.engine,
      ok: false,
      ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function allSnapshots(reg: RegistryFile): Promise<SiteCard[]> {
  return Promise.all(reg.sites.map((s) => siteSnapshot(reg, s.slug)));
}
