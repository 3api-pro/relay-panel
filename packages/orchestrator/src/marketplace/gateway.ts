/**
 * 计量网关客户端（规格 §7）。HTTP 契约与 docs/METERING-GATEWAY.md 一致：
 *   POST   {gw}/v1/keys                body {site, template, models[]} → 200 {keyRef, apiKey, baseUrl}
 *   DELETE {gw}/v1/keys/{keyRef}       → 204
 *   GET    {gw}/v1/usage?keyRef=&from=ISO&to=ISO → {rows:[…]}
 * 全部带 Authorization: Bearer <RP_METERING_GATEWAY_TOKEN>。
 * 铁律：错误信息绝不含 token/apiKey——错误只带 method/path/状态码与格式说明。
 */

/** 网关用量行（与 server.ts 的占位类型、test/fakes.ts 的 FakeGateway 结构同构） */
export interface MeteringUsageRow {
  periodStart: string;
  periodEnd: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  upstreamCost: number;
  billedCost: number;
}

/** 计量网关接口（G2 权威定义；server.ts 占位类型与本接口保持结构同构，无须互相 import） */
export interface MeteringGateway {
  issueKey(input: {
    siteSlug: string;
    templateKey: string;
    models: string[];
  }): Promise<{ keyRef: string; apiKey: string; baseUrl: string }>;
  revokeKey(keyRef: string): Promise<void>;
  pullUsage(keyRef: string, from: Date, to: Date): Promise<MeteringUsageRow[]>;
}

const REQUEST_TIMEOUT_MS = 10_000;

function fieldError(path: string): Error {
  return new Error(`计量网关响应格式无效: ${path}`);
}

/** 逐字段校验网关返回的用量行——上游是外部服务，不可信任其形状 */
function normalizeUsageRow(value: unknown, index: number): MeteringUsageRow {
  const o = (value ?? {}) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v === '') throw fieldError(`rows[${index}].${k}`);
    return v;
  };
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw fieldError(`rows[${index}].${k}`);
    return v;
  };
  return {
    periodStart: str('periodStart'),
    periodEnd: str('periodEnd'),
    requests: num('requests'),
    promptTokens: num('promptTokens'),
    completionTokens: num('completionTokens'),
    upstreamCost: num('upstreamCost'),
    billedCost: num('billedCost'),
  };
}

export class HttpMeteringGateway implements MeteringGateway {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { acceptNotFound?: boolean },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // 网络层失败：只带 method 与 path（不含 query——query 里有 keyRef，虽非密钥仍最小化）
      const kind = err instanceof Error ? err.name : 'Error';
      throw new Error(`计量网关请求失败: ${method} ${path.split('?')[0]}: ${kind}`);
    }
    // 契约 §3.2：DELETE 的 404（keyRef 不存在）与 2xx 同属可接受语义（幂等撤销），不算失败
    if (!res.ok && !(opts?.acceptNotFound === true && res.status === 404)) {
      throw new Error(`计量网关请求失败: ${method} ${path.split('?')[0]}: HTTP ${res.status}`);
    }
    return res;
  }

  async issueKey(input: {
    siteSlug: string;
    templateKey: string;
    models: string[];
  }): Promise<{ keyRef: string; apiKey: string; baseUrl: string }> {
    const res = await this.request('POST', '/v1/keys', {
      site: input.siteSlug,
      template: input.templateKey,
      models: input.models,
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (
      typeof data.keyRef !== 'string' ||
      data.keyRef === '' ||
      typeof data.apiKey !== 'string' ||
      data.apiKey === '' ||
      typeof data.baseUrl !== 'string' ||
      data.baseUrl === ''
    ) {
      throw new Error('计量网关响应格式无效: 缺少 keyRef/apiKey/baseUrl');
    }
    return { keyRef: data.keyRef, apiKey: data.apiKey, baseUrl: data.baseUrl };
  }

  async revokeKey(keyRef: string): Promise<void> {
    // 契约 §3.2：keyRef 不存在返回 404，与 204 同视为幂等成功（撤销目标本就不该存在），只对其余非 2xx 抛错
    await this.request('DELETE', `/v1/keys/${encodeURIComponent(keyRef)}`, undefined, { acceptNotFound: true });
  }

  async pullUsage(keyRef: string, from: Date, to: Date): Promise<MeteringUsageRow[]> {
    const qs = new URLSearchParams({ keyRef, from: from.toISOString(), to: to.toISOString() });
    const res = await this.request('GET', `/v1/usage?${qs.toString()}`);
    const data = (await res.json()) as { rows?: unknown };
    if (!Array.isArray(data.rows)) throw new Error('计量网关响应格式无效: 缺少 rows');
    return data.rows.map((row, i) => normalizeUsageRow(row, i));
  }
}
