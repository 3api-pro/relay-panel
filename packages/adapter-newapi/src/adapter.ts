import type {
  ChannelRecord,
  ChannelSpec,
  ChannelTestResult,
  CredentialStore,
  EngineAdapter,
  EngineAdminClient,
  EngineCapabilities,
  GroupRecord,
  GroupSpec,
  HealthReport,
  InstanceInfo,
  SiteBranding,
  SiteUserRecord,
  UsageSummary,
} from '@relay-panel/adapter-core';
import { NewapiHttp, type NewapiAuth, type PageInfo } from './http.js';
import { loginRoot, sessionAuth } from './auth.js';

/** ChannelSpec.protocol → new-api channel type 枚举 */
const PROTOCOL_TO_TYPE: Record<ChannelSpec['protocol'], number> = {
  openai: 1,
  anthropic: 14,
  gemini: 24,
  'openai-responses': 57,
};
const TYPE_TO_PROTOCOL: Record<number, ChannelSpec['protocol']> = {
  1: 'openai',
  14: 'anthropic',
  24: 'gemini',
  57: 'openai-responses',
};

const QUOTA_PER_USD = 500_000; // new-api: 1 USD = 500000 quota

interface NaChannel {
  id: number;
  type: number;
  name: string;
  base_url?: string;
  models?: string;
  group?: string;
  status: number;
  priority?: number;
  weight?: number;
  model_mapping?: string;
}

interface NaUser {
  id: number;
  username?: string;
  email?: string;
  role: number;
  status: number;
  quota?: number;
}

interface NaQuotaData {
  model_name: string;
  count: number;
  token_used: number;
  quota: number;
}

function channelToRecord(ch: NaChannel): ChannelRecord {
  return {
    id: String(ch.id),
    name: ch.name,
    enabled: ch.status === 1,
    protocol: TYPE_TO_PROTOCOL[ch.type] ?? 'openai',
    baseUrl: ch.base_url ?? '',
    apiKey: '<redacted>',
    models: ch.models ? ch.models.split(',').map((m) => m.trim()).filter(Boolean) : [],
    groups: ch.group ? ch.group.split(',').map((g) => g.trim()).filter(Boolean) : [],
    ...(ch.priority !== undefined ? { priority: ch.priority } : {}),
    ...(ch.weight !== undefined ? { weight: ch.weight } : {}),
  };
}

export class NewapiAdapter implements EngineAdapter {
  readonly engine = 'newapi' as const;
  readonly dbDirect = false;

  async capabilities(_inst: InstanceInfo): Promise<EngineCapabilities> {
    return {
      userAccessTokens: true,
      multiGroupKeys: false, // token 仅绑单个分组字符串
      anthropicNative: true, // type=14 原生 /v1/messages
      subscriptionBilling: true,
    };
  }

  async health(inst: InstanceInfo): Promise<HealthReport> {
    const started = Date.now();
    try {
      const res = await fetch(`${inst.baseUrl}/api/status`, { signal: AbortSignal.timeout(8000) });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean };
      return { ok: res.ok && j.success === true, httpOk: res.ok, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, httpOk: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async connect(inst: InstanceInfo, credentials: CredentialStore): Promise<EngineAdminClient> {
    const cred = await credentials.resolve(inst.credentialRef);
    let auth: NewapiAuth;
    if (cred.kind === 'admin-token') {
      // access_token + userId（userId 在 extra.userId），双头鉴权，非破坏性。
      const userId = Number(cred.extra?.userId ?? cred.adminEmail);
      if (!Number.isFinite(userId)) throw new Error('newapi admin-token requires extra.userId');
      auth = { kind: 'access-token', token: cred.secret, userId };
    } else if (cred.kind === 'admin-password') {
      // 用户名密码登录 → 直接用 session（非破坏性，不铸/不轮换 access_token）。
      // adminEmail 字段这里承载 root 用户名。
      if (!cred.adminEmail) throw new Error('newapi admin-password requires adminEmail (username)');
      const { cookie, userId } = await loginRoot(inst.baseUrl, cred.adminEmail, cred.secret);
      auth = sessionAuth(cookie, userId);
    } else {
      throw new Error(`unsupported credential kind for newapi: ${cred.kind}`);
    }
    return new NewapiAdminClient(inst, new NewapiHttp(inst.baseUrl, auth));
  }
}

export class NewapiAdminClient implements EngineAdminClient {
  constructor(
    readonly inst: InstanceInfo,
    private readonly http: NewapiHttp,
  ) {}

  channels = {
    list: async (): Promise<ChannelRecord[]> => {
      const items = await this.http.listAll<NaChannel>('/api/channel/');
      return items.map(channelToRecord);
    },

    create: async (spec: ChannelSpec): Promise<ChannelRecord> => {
      const body = {
        mode: 'single',
        channel: {
          type: PROTOCOL_TO_TYPE[spec.protocol],
          name: spec.name,
          key: spec.apiKey,
          base_url: spec.baseUrl,
          models: spec.models.join(','), // 数组 → 逗号字符串
          group: (spec.groups ?? []).join(','),
          model_mapping: spec.modelMapping ? JSON.stringify(spec.modelMapping) : '',
          priority: spec.priority ?? 0,
          weight: spec.weight ?? 0,
          status: 1,
          ...((spec.raw as Record<string, unknown>) ?? {}),
        },
      };
      await this.http.post('/api/channel/', body);
      // AddChannel 不回显创建后的 channel，回读按名字定位最新一条
      const all = await this.http.listAll<NaChannel>('/api/channel/');
      const mine = all.filter((c) => c.name === spec.name).sort((a, b) => b.id - a.id)[0];
      if (!mine) throw new Error('channel created but not found on readback');
      return channelToRecord(mine);
    },

    update: async (
      id: string,
      patch: Partial<ChannelSpec> & { enabled?: boolean },
    ): Promise<ChannelRecord> => {
      // 启停走**独立端点** POST /api/channel/:id/status（bulk PUT 会拒绝 status 字段
      // → "Invalid parameters"）。1=启用 2=禁用。
      if (patch.enabled !== undefined) {
        await this.http.post(`/api/channel/${id}/status`, { status: patch.enabled ? 1 : 2 });
      }
      // 其余字段走 PUT /api/channel/（整体替换，只回写干净的可写标量子集，不含 status；
      // GET 会把 tag/setting/param_override 等返回为 null，整体回写会绑定失败）。
      const fieldPatch =
        patch.name !== undefined ||
        patch.baseUrl !== undefined ||
        patch.models !== undefined ||
        patch.groups !== undefined ||
        patch.modelMapping !== undefined ||
        patch.priority !== undefined ||
        patch.weight !== undefined ||
        patch.apiKey !== undefined;
      if (fieldPatch) {
        const c = await this.http.get<Record<string, unknown>>(`/api/channel/${id}`);
        const body: Record<string, unknown> = {
          id: Number(id),
          type: c.type,
          name: patch.name ?? c.name,
          base_url: patch.baseUrl ?? c.base_url,
          models: patch.models ? patch.models.join(',') : c.models,
          group: patch.groups ? patch.groups.join(',') : c.group,
          model_mapping: patch.modelMapping ? JSON.stringify(patch.modelMapping) : (c.model_mapping ?? ''),
          priority: patch.priority ?? c.priority,
          weight: patch.weight ?? c.weight,
        };
        // key 从 GET 取不到（脱敏为空）；仅显式改 key 时发送，否则省略以保留原 key。
        if (patch.apiKey !== undefined) body.key = patch.apiKey;
        await this.http.put('/api/channel/', body);
      }
      const fresh = await this.http.get<NaChannel>(`/api/channel/${id}`);
      return channelToRecord(fresh);
    },

    remove: async (id: string): Promise<void> => {
      await this.http.delete(`/api/channel/${id}`);
    },

    test: async (id: string, model?: string): Promise<ChannelTestResult> => {
      try {
        const q = model ? `?model=${encodeURIComponent(model)}` : '';
        // test 端点直接返回 {success,message,time}，用 request 拿信封需特殊处理：
        const res = await fetch(`${this.inst.baseUrl}/api/channel/test/${id}${q}`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(30_000),
        });
        const j = (await res.json()) as { success?: boolean; message?: string; time?: number };
        return j.success
          ? { ok: true, ...(j.time ? { latencyMs: Math.round(j.time * 1000) } : {}), ...(model ? { model } : {}) }
          : { ok: false, error: j.message ?? 'test failed' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  groups = {
    // new-api 分组本质是 option GroupRatio 的键；GET /api/group 只给名字数组。
    list: async (): Promise<GroupRecord[]> => {
      const names = await this.http.get<string[]>('/api/group/');
      const ratios = await this.groupRatios().catch(() => ({}) as Record<string, number>);
      return names.map((name) => ({ id: name, name, ratio: ratios[name] ?? 1 }));
    },

    // create/update = 改 option GroupRatio JSON（需 root 权限）
    create: async (spec: GroupSpec): Promise<GroupRecord> => {
      const ratios = await this.groupRatios();
      ratios[spec.name] = spec.ratio;
      await this.http.put('/api/option/', { key: 'GroupRatio', value: JSON.stringify(ratios) });
      return { id: spec.name, name: spec.name, ratio: spec.ratio };
    },

    update: async (id: string, patch: Partial<GroupSpec>): Promise<GroupRecord> => {
      const ratios = await this.groupRatios();
      if (patch.ratio !== undefined) ratios[id] = patch.ratio;
      await this.http.put('/api/option/', { key: 'GroupRatio', value: JSON.stringify(ratios) });
      return { id, name: id, ratio: ratios[id] ?? 1 };
    },
  };

  users = {
    list: async (query?: { search?: string; page?: number }): Promise<SiteUserRecord[]> => {
      const path = query?.search
        ? `/api/user/search?keyword=${encodeURIComponent(query.search)}`
        : '/api/user/';
      const data = await this.http.get<PageInfo<NaUser> | NaUser[]>(
        `${path}${path.includes('?') ? '&' : '?'}p=${query?.page ?? 1}&page_size=100`,
      );
      const items = Array.isArray(data) ? data : data.items;
      return items.map((u) => ({
        id: String(u.id),
        role: u.role >= 10 ? 'admin' : 'user',
        status: u.status === 1 ? 'active' : 'disabled',
        ...(u.email ? { email: u.email } : {}),
        ...(u.username ? { username: u.username } : {}),
        ...(u.quota !== undefined ? { balance: u.quota / QUOTA_PER_USD } : {}),
      }));
    },

    setStatus: async (id: string, status: 'active' | 'disabled'): Promise<void> => {
      await this.http.post('/api/user/manage', {
        id: Number(id),
        action: status === 'active' ? 'enable' : 'disable',
      });
    },
  };

  settings = {
    // ⚠️ /api/option 需要 root（role 100）权限，非 root 账号会 403。
    getBranding: async (): Promise<SiteBranding> => {
      const opts = await this.options();
      return {
        siteName: opts.SystemName ?? '',
        ...(opts.Logo ? { logoUrl: opts.Logo } : {}),
        ...(opts.Notice ? { announcement: opts.Notice } : {}),
      };
    },

    setBranding: async (branding: Partial<SiteBranding>): Promise<void> => {
      if (branding.siteName !== undefined) await this.http.put('/api/option/', { key: 'SystemName', value: branding.siteName });
      if (branding.logoUrl !== undefined) await this.http.put('/api/option/', { key: 'Logo', value: branding.logoUrl });
      if (branding.announcement !== undefined) await this.http.put('/api/option/', { key: 'Notice', value: branding.announcement });
    },

    getRaw: async (key: string): Promise<string | null> => {
      const opts = await this.options();
      return opts[key] ?? null;
    },

    setRaw: async (key: string, value: string): Promise<void> => {
      await this.http.put('/api/option/', { key, value });
    },
  };

  stats = {
    // /api/data/ 按模型聚合 count/token_used/quota。new-api 不区分 prompt/completion，
    // 故 promptTokens=0，completionTokens=总 token（看板求和口径正确）。
    usage: async (from: Date, to: Date): Promise<UsageSummary> => {
      const start = Math.floor(from.getTime() / 1000);
      const end = Math.floor(to.getTime() / 1000);
      const rows = await this.http.get<NaQuotaData[]>(
        `/api/data/?start_timestamp=${start}&end_timestamp=${end}`,
      );
      const byModel: NonNullable<UsageSummary['byModel']> = {};
      let requests = 0;
      let tokens = 0;
      let quota = 0;
      for (const r of rows ?? []) {
        requests += r.count;
        tokens += r.token_used;
        quota += r.quota;
        const m = (byModel[r.model_name] ??= { requests: 0, tokens: 0, cost: 0 });
        m.requests += r.count;
        m.tokens += r.token_used;
        m.cost += r.quota / QUOTA_PER_USD;
      }
      return {
        from,
        to,
        requests,
        promptTokens: 0,
        completionTokens: tokens,
        costUnit: 'USD',
        cost: quota / QUOTA_PER_USD,
        byModel,
      };
    },
  };

  // ---- helpers ----

  private authHeaders(): Record<string, string> {
    // 仅供 channels.test 的裸 fetch 用；复用 http 的鉴权语义。
    return this.http.authHeadersForRawFetch();
  }

  private async options(): Promise<Record<string, string>> {
    const list = await this.http.get<Array<{ key: string; value: string }>>('/api/option/');
    const out: Record<string, string> = {};
    for (const o of list) out[o.key] = o.value;
    return out;
  }

  private async groupRatios(): Promise<Record<string, number>> {
    const opts = await this.options();
    const raw = opts.GroupRatio;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, number>;
    } catch {
      return {};
    }
  }
}
