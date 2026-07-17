# 计量网关 HTTP 契约（Metering Gateway Contract）

本文是 relay-panel 渠道市场 **managed 模式**所依赖的计量网关的完整接口规格。网关本体不在本仓库（独立部署、可闭源）；任何按本契约实现的服务都可以直接对接。编排器侧的调用实现在 `packages/orchestrator/src/marketplace/gateway.ts`（`HttpMeteringGateway`），二者必须保持同构。

## 1. 角色与数据流

```
站长在面板启用 managed 模板
        │
        ▼
编排器 ──1─▶ POST {gw}/v1/keys        申请 per-site 计量 key
        ◀──   {keyRef, apiKey, baseUrl}
        │
        ▼
编排器把 {baseUrl, apiKey} 作为渠道注入目标站（引擎 admin API）
        │  站点流量经该 key 打到网关，网关代理上游并逐笔计量
        ▼
编排器 ──2─▶ GET {gw}/v1/usage        周期性拉取用量入本地账本（分账依据）
编排器 ──3─▶ DELETE {gw}/v1/keys/…    站长撤销授权时吊销 key
```

- 网关对**每次授权**签发独立 key：一个 `(站点, 模板)` 授权对应一把 key，计量与吊销都以 key 为粒度。
- 编排器持有的网关配置：`RP_METERING_GATEWAY_URL`（如 `https://gw.example.com`）与 `RP_METERING_GATEWAY_TOKEN`。二者未配置时 managed 模板在面板中不可启用（400）。

## 2. 认证

所有请求携带静态 Bearer token：

```
Authorization: Bearer <RP_METERING_GATEWAY_TOKEN>
```

- 网关必须校验该 token，失败返回 `401`。
- 该 token 是编排器实例与网关之间的机器凭据，与站点流量所用的 `apiKey` 无关。
- 编排器保证：token 不出现在日志、错误信息、审计里。网关侧应同样对待。

## 3. 端点

### 3.1 签发 key —— `POST /v1/keys`

请求：

```json
{
  "site": "site-a",
  "template": "market-claude",
  "models": ["model-a", "model-b"]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| site | string | 站点 slug（`^[a-z0-9][a-z0-9-]{1,31}$`），网关可用于命名/归因 |
| template | string | 模板 key，决定上游产品与计价 |
| models | string[] | 该授权允许的对外模型名列表 |

成功响应 `200`：

```json
{
  "keyRef": "kr_9f2c1a7e",
  "apiKey": "mk-example-only-returned-once",
  "baseUrl": "https://relay.gw.example.com"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| keyRef | string | key 的稳定引用（不透露 key 本体），后续吊销/拉用量都用它。建议不可猜测、≤128 字符 |
| apiKey | string | 明文 key，**只在本响应出现一次**。编排器立即注入引擎渠道，绝不落库明文、绝不再次索取。网关不得提供再次读取明文的接口 |
| baseUrl | string | 站点渠道应指向的网关接入地址 |

约束：

- 同一 `(site, template)` 重复调用应视为**新授权**签发新 key（编排器在授权层面自己防重复）；网关无需做幂等合并。
- 签发失败（模板不存在、配额拒绝等）返回非 2xx + 错误体（见 §4）。

### 3.2 吊销 key —— `DELETE /v1/keys/{keyRef}`

- 成功：`204 No Content`（无响应体）。
- `keyRef` 不存在：`404`。
- 吊销后该 key 的流量必须立刻被网关拒绝；已产生的用量仍可（也应）继续经 `/v1/usage` 查询——账本要能覆盖到吊销前的最后一段。
- 建议幂等：对已吊销的 keyRef 重复 DELETE 返回 `204` 亦可接受（编排器把 2xx/404 之外的一切视为失败）。

### 3.3 拉取用量 —— `GET /v1/usage?keyRef=&from=&to=`

| query | 说明 |
|---|---|
| keyRef | 目标 key 引用 |
| from | ISO 8601（UTC），窗口起点（含） |
| to | ISO 8601（UTC），窗口终点（不含） |

示例：`GET /v1/usage?keyRef=kr_9f2c1a7e&from=2026-07-01T00:00:00.000Z&to=2026-07-18T00:00:00.000Z`

成功响应 `200`：

```json
{
  "rows": [
    {
      "periodStart": "2026-07-01T00:00:00.000Z",
      "periodEnd": "2026-07-02T00:00:00.000Z",
      "requests": 1834,
      "promptTokens": 5200000,
      "completionTokens": 910000,
      "upstreamCost": 14.2,
      "billedCost": 21.3
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| periodStart / periodEnd | string (ISO 8601 UTC) | 聚合桶窗口，start 含、end 不含 |
| requests | int | 请求数 |
| promptTokens / completionTokens | int | token 计量 |
| upstreamCost | number | 网关侧的上游真实成本 |
| billedCost | number | 应向站长结算的金额（分账口径） |

约束（网关必须满足，否则账本会重复/漏账）：

- **固定桶边界**：按自然时间桶聚合（建议按天，UTC 0 点切齐；按小时亦可，但同一 keyRef 必须始终同一粒度）。同一个桶在其结束后数据必须稳定（重复查询返回相同行）。
- `from/to` 只做窗口过滤：返回 `periodStart >= from && periodStart < to` 的桶。**尚未结束的当前桶不要返回**（等桶封口再给），否则会以不完整数据入账。
- 无数据返回 `{"rows": []}`（200，不是 404）。
- 金额单位：网关与模板计价保持一致（默认口径 USD）；同一网关内必须统一。

编排器的拉取循环（`RP_LEDGER_PULL_INTERVAL_MS`，默认 1 小时）：对每个 active 且带 `keyRef` 的授权，`from` = 本地账本该授权最新 `periodEnd`（无记录则取授权创建时间），`to` = 当前时间；拿到的行按 `(grantId, periodStart, source='gateway')` 幂等 upsert。因此**重复返回同一桶是安全的，改写历史桶不是**。

## 4. 错误约定

非 2xx 响应建议统一 JSON 错误体：

```json
{ "error": "human readable message" }
```

| 状态码 | 场景 |
|---|---|
| 400 | 参数缺失/非法（models 空、时间窗颠倒等） |
| 401 | Bearer token 缺失或无效 |
| 404 | keyRef 不存在 |
| 429 | 网关侧限流（编排器会在下个周期重试拉取） |
| 5xx | 网关内部错误 |

编排器行为：任何非 2xx（DELETE 场景另接受 404 语义按端点说明处理）都会抛错并中断当前操作；错误信息**不含** token 与 apiKey。授权路径上的网关错误直接回显给面板操作者（502/400）；拉取循环里的错误只记日志，下个周期重试。

## 5. 安全要求

- 全程 HTTPS；网关不得在日志中记录 `apiKey` 明文。
- `apiKey` 只出现在签发响应里一次；`keyRef` 可安全出现在日志/账本中。
- 网关应对 `POST /v1/keys` 做速率限制与来源审计（token 泄露时可追溯）。
- token 轮换：网关支持多 token 并存（新旧并行一段时间），编排器侧改 `RP_METERING_GATEWAY_TOKEN` 后重启即可无缝切换。
