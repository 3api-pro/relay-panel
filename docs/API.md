# API 参考

relay-panel 编排器（orchestrator）的 HTTP API 全表。默认监听 `http://127.0.0.1:7100`（`PORT` / `RP_HOST` 可配，见 [SELF-HOST.md](SELF-HOST.md)）。

> 本文对应规格 §4-§9。个别端点仍在集成校对中，以实际代码为最终事实；差异会在发版说明中列出。

## 1. 约定

### 1.1 认证方式：cookie session

除明确标注"免认证"的端点外，所有 `/api/*` 都要求合法会话：

1. `POST /api/auth/login` 成功后服务端 `Set-Cookie: rp_session=<token>`（httpOnly、`SameSite=Lax`、`Path=/`）。
2. 之后的请求浏览器自动携带 cookie；脚本调用需自行透传 `Cookie: rp_session=…`。
3. 会话有效期 `RP_SESSION_TTL_HOURS`（默认 168 小时），剩余寿命不足一半时自动滑动续期。
4. 登出、改密（其余会话）、账号被禁用都会吊销会话。

无合法会话访问受保护端点 → `401 {"error":"未登录或会话已过期"}`。

没有 API key / Bearer 形态的面板 API（唯一例外：`GET /metrics` 可用 `Authorization: Bearer <RP_METRICS_TOKEN>`，见 §9）。

### 1.2 CSRF

非 GET 的 `/api/*` 请求，若携带 `Origin` 头且其 host 与请求 `Host` 头不一致 → `403 {"error":"跨站请求被拒绝"}`。

- 同源浏览器请求与不带 `Origin` 的非浏览器客户端（curl 等）不受影响。
- **经反向代理部署时必须透传原始 `Host`**（`proxy_set_header Host $host`），否则所有写操作都会被 CSRF 拦截。详见 [SELF-HOST.md](SELF-HOST.md) 反代一节。

### 1.3 统一错误体

所有业务错误统一返回：

```json
{ "error": "中文错误消息" }
```

| 状态码 | 典型含义 |
|---|---|
| 400 | 参数无效（`请求参数无效: …`）、业务前置条件不满足 |
| 401 | 未登录或会话已过期 / 登录失败（`邮箱或密码错误`，不区分账号不存在与密码错误） |
| 403 | 角色无权限（viewer 写、非 root 管账号）、跨站请求、无权访问他人站点任务 |
| 404 | 资源不存在（含无权查看的站点，统一 `站点不存在`，不泄露存在性）；未知 `/api/*` 路径 → `接口不存在` |
| 409 | 冲突（邮箱已注册、同站点已有排队/执行中任务等） |
| 502 | 下游（引擎 / 计量网关 / Caddy）调用失败 |

### 1.4 角色

三种角色（RBAC 矩阵详见 [SECURITY.md](SECURITY.md)）：

- `root`：全量读写 + 账号/邀请/模板/订阅/全局设置管理。
- `operator`：只能看到并操作**自己名下**的站点及其任务/告警/账本。
- `viewer`：全站只读，任何写操作 → 403。

下表"角色"列含义：`所有` = 三种角色均可（operator 自动限定 own 范围）；`写` = root + operator(own)；`root` = 仅 root。

### 1.5 通用说明

- 请求/响应均为 JSON（`Content-Type: application/json`）。
- 时间戳为 UTC，格式 `YYYY-MM-DD HH:MM:SS.sss`。
- 任何响应中的引擎渠道 `apiKey` 一律强制为 `"<redacted>"`，无论引擎返回什么。
- 所有写操作落审计流水（`audit_events`），payload 经脱敏。

## 2. 健康与元信息

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 免认证 | 存活探测 → `{"ok":true,"service":"relay-panel-orchestrator"}` |

## 3. 认证与账号（/api/auth、/api/invites、/api/operators）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 免认证 | 登录，种 session cookie |
| POST | `/api/auth/logout` | 所有 | 登出并吊销当前会话 |
| GET | `/api/auth/me` | 所有 | 当前登录人信息 |
| POST | `/api/auth/signup` | 免认证 | 注册（受 `RP_SIGNUP_MODE` 控制） |
| POST | `/api/auth/password` | 所有 | 修改自己密码 |
| GET | `/api/invites` | root | 邀请列表（不含完整 token） |
| POST | `/api/invites` | root | 生成邀请（完整 token 仅此一次返回） |
| DELETE | `/api/invites/:token` | root | 删除未使用的邀请（可用 8 位前缀） |
| GET | `/api/operators` | root | 操作员列表（含站点数、订阅） |
| PATCH | `/api/operators/:id` | root | 修改角色/状态/显示名 |

### POST /api/auth/login

```json
// 请求
{ "email": "op@example.com", "password": "********" }
// 200
{ "email": "op@example.com", "displayName": "示例站长", "role": "operator", "signupMode": "invite" }
```

失败统一 `401 {"error":"邮箱或密码错误"}`（不区分账号不存在 / 密码错误 / 已禁用）。

### POST /api/auth/signup

```json
// 请求（invite 模式必带 inviteToken；密码至少 8 位）
{ "email": "new@example.com", "password": "********", "displayName": "新站长", "inviteToken": "0123abcd0123abcd0123abcd0123abcd" }
// 200
{ "email": "new@example.com", "displayName": "新站长", "role": "operator" }
```

- `RP_SIGNUP_MODE=closed` → `403 注册已关闭`；`invite` 模式邀请无效/过期 → `400 邀请码无效或已过期`；邮箱重复 → `409 邮箱已注册`。
- 新账号角色取邀请上的 `role`（open 模式固定 `operator`）。

### POST /api/auth/password

```json
{ "current": "********", "next": "********" }
// 200: { "ok": true }（同时吊销该账号除当前会话外的全部会话）
```

### POST /api/invites

```json
// 请求（全部可选）
{ "role": "operator", "note": "给示例合作方", "ttlHours": 72 }
// 200 —— token 完整值只在这里出现一次，请立即保存
{ "token": "0123abcd0123abcd0123abcd0123abcd", "role": "operator", "note": "给示例合作方", "expiresAt": "2026-07-21 08:00:00.000" }
```

`GET /api/invites` 列表中 token 只回 8 位前缀（`token: "0123abcd…"`，另有 `tokenPrefix` 字段）；`DELETE /api/invites/:token` 接受完整 token 或 8 位前缀，已使用的邀请不可删（保留作审计）。

### PATCH /api/operators/:id

```json
{ "role": "viewer", "status": "disabled", "displayName": "改名" }
```

不允许禁用/降级**最后一个 active root**（`400 不能禁用或降级最后一个活跃 root`）。`status:"disabled"` 立即吊销目标账号全部会话。

## 4. 站点（/api/sites）

读端点三种角色均可（operator 仅 own）；写端点 = 写权限 + 站点归属校验，全部落审计。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/sites` | 所有 | 站点列表 + 聚合快照（15s 缓存） |
| GET | `/api/sites/:slug` | 所有 | 单站视图 |
| GET | `/api/sites/:slug/channels` | 所有 | 引擎渠道实时列表（apiKey 恒为 `<redacted>`） |
| GET | `/api/sites/:slug/groups` | 所有 | 引擎分组实时列表 |
| GET | `/api/sites/:slug/users?search=` | 所有 | 引擎用户实时列表 |
| GET | `/api/sites/:slug/branding` | 所有 | 站点品牌 |
| GET | `/api/sites/:slug/usage?days=7` | 所有 | 按天用量序列（days ≤ 30，10min 缓存） |
| GET | `/api/sites/:slug/audit?limit=50` | 所有 | 该站审计流水 |
| POST | `/api/sites` | 写 | 新建站点 → provision 任务 |
| POST | `/api/sites/:slug/upgrade` | 写 | 升级 → upgrade 任务 |
| POST | `/api/sites/:slug/start` | 写 | 启动 → start 任务 |
| POST | `/api/sites/:slug/stop` | 写 | 停止 → stop 任务 |
| DELETE | `/api/sites/:slug` | 写 | 销毁 → destroy 任务（须 confirm） |
| POST | `/api/sites/:slug/channels` | 写 | 站内新建渠道（ChannelSpec） |
| PATCH | `/api/sites/:slug/channels/:id` | 写 | 渠道更新（含 `enabled` 启停） |
| DELETE | `/api/sites/:slug/channels/:id` | 写 | 渠道删除 |
| POST | `/api/sites/:slug/channels/:id/test` | 写 | 渠道连通测试 `{model?}` |
| PATCH | `/api/sites/:slug/users/:id` | 写 | 站内用户启停 `{status:"active"|"disabled"}` |
| PUT | `/api/sites/:slug/branding` | 写 | 品牌 `{siteName?,logoUrl?,announcement?}` |

站点不存在或无权查看统一 `404 {"error":"站点不存在"}`。

### GET /api/sites

```json
{
  "sites": [
    {
      "slug": "site-a",
      "label": "示例站 A",
      "engine": "sub2api",
      "version": "1.2.3",
      "status": "active",
      "managed": "compose",
      "hostPort": 18101,
      "domains": ["api.example.com"],
      "operatorEmail": "op@example.com",
      "createdAt": "2026-07-01 08:00:00.000",
      "activeJob": null,
      "ok": true,
      "latencyMs": 42,
      "groups": 3,
      "accounts": { "total": 5, "active": 4 },
      "usage24h": { "requests": 1280, "tokens": 3400000, "cost": 12.5 },
      "branding": "示例站 A"
    }
  ],
  "generatedAt": "2026-07-18 03:00:00.000"
}
```

- `status`：`pending | provisioning | active | stopped | failed:<step> | destroyed`。
- `managed`：`compose`（面板开的站，可做生命周期操作）| `external`（接管的存量站，生命周期端点一律 `400 外部接管站点不支持生命周期操作`）。
- `activeJob`：`{id,kind,status}` 或 `null`。
- 实时字段（`ok/latencyMs/groups/accounts/usage24h/branding/error`）来自 15s 缓存的引擎快照；`destroyed` 站跳过探测。
- 响应不含 `credentialRef`、`dataDir`、`composeProject` 等内部字段。

### POST /api/sites

```json
// 请求
{
  "slug": "site-b",
  "label": "示例站 B",
  "engine": "newapi",
  "version": "0.9.9",
  "adminEmail": "admin@example.com",
  "branding": { "siteName": "示例站 B" }
}
// 200
{ "slug": "site-b", "jobId": 42 }
```

- `slug` 规则 `^[a-z0-9][a-z0-9-]{1,31}$` 且全局唯一；`version` 禁止 `latest`（必须钉版本）；`engine ∈ {sub2api, newapi}`。
- `hostPort` 可省略：从 `RP_PORT_RANGE` 里取未占用且 TCP 探测空闲的最小端口。
- 受套餐配额约束（见 §8）：超过配额 → 400。
- 返回后用 `GET /api/jobs/:jobId` 跟踪 provision 步骤。

### DELETE /api/sites/:slug

```json
// 请求体：confirm 必须与 slug 完全一致，否则 400
{ "confirm": "site-b", "keepData": false }
```

销毁后行不删（`status: "destroyed"`），保留审计与账本关联。

### 渠道写端点

`POST /api/sites/:slug/channels` 请求体为引擎无关的 ChannelSpec：

```json
{
  "name": "示例上游",
  "protocol": "anthropic",
  "baseUrl": "https://upstream.example.com",
  "apiKey": "sk-example",
  "models": ["model-a", "model-b"],
  "modelMapping": { "model-a": "model-a-latest" },
  "groups": ["1"],
  "priority": 10
}
```

`protocol ∈ {anthropic, openai, openai-responses, gemini}`。响应为创建后的 ChannelRecord（`apiKey` 恒 `"<redacted>"`）。

### GET /api/sites/:slug/usage

```json
{
  "buckets": [
    { "date": "2026-07-17", "requests": 1200, "tokens": 3100000, "cost": 11.2 },
    { "date": "2026-07-18", "requests": 300, "tokens": 800000, "cost": 2.9 }
  ],
  "costUnit": "USD"
}
```

## 5. 任务（/api/jobs）

任务只读；写入口只有各写路由触发的 `enqueue`。同一站点（slug）同一时间只允许一个排队/执行中的任务（冲突 → 409），全局并发 2。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/jobs?slug=&limit=` | 所有 | 任务列表（operator 仅 own 站；limit 默认 50，上限 200） |
| GET | `/api/jobs/:id` | 所有 | 单任务；operator 查他人站任务 → `403 无权访问该任务` |

```json
// GET /api/jobs/42 → 200
{
  "job": {
    "id": 42,
    "kind": "provision",
    "siteId": 7,
    "slug": "site-b",
    "payload": { "version": "0.9.9" },
    "status": "succeeded",
    "steps": [
      { "step": "render", "status": "ok", "at": "2026-07-18 03:00:01.000" },
      { "step": "compose-up", "status": "ok", "at": "2026-07-18 03:00:20.000" },
      { "step": "health", "status": "ok", "at": "2026-07-18 03:00:35.000" },
      { "step": "admin-init", "status": "ok", "at": "2026-07-18 03:00:40.000" }
    ],
    "error": null,
    "createdBy": "op@example.com",
    "createdAt": "2026-07-18 03:00:00.000",
    "startedAt": "2026-07-18 03:00:01.000",
    "finishedAt": "2026-07-18 03:00:41.000"
  }
}
```

`kind ∈ {provision, upgrade, start, stop, destroy}`；`status ∈ {queued, running, succeeded, failed, cancelled}`。`payload` 与 `steps.detail`、`error` 输出前均经脱敏。

## 6. 渠道市场（/api/marketplace）

模板 = 上游渠道产品的抽象；授权（grant）= 把模板一键注入某个站。两种来源：

- `byo`：站长自带上游（授权时传 `byo.baseUrl` + `byo.apiKey`）。
- `managed`：由计量网关签发 per-site key（需配置 `RP_METERING_GATEWAY_URL/TOKEN`，否则 `400 计量网关未配置`）。网关契约见 [METERING-GATEWAY.md](METERING-GATEWAY.md)。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/marketplace/templates` | 所有 | 已启用模板列表 |
| POST | `/api/marketplace/templates` | root | 新建模板 |
| PATCH | `/api/marketplace/templates/:id` | root | 修改模板 |
| DELETE | `/api/marketplace/templates/:id` | root | 删除/停用模板 |
| GET | `/api/marketplace/grants?siteSlug=` | 所有 | 授权列表（关联模板与站点信息） |
| POST | `/api/marketplace/grants` | 写 | 启用模板 → 注入渠道 |
| DELETE | `/api/marketplace/grants/:id` | 写 | 撤销（站不可达时 `?force=1` 仅改状态） |
| GET | `/api/marketplace/ledger?siteSlug=&month=YYYY-MM` | 所有 | 账本查询 `{rows, totals}` |
| POST | `/api/marketplace/ledger/import` | root | 手工补账（source=manual） |

### POST /api/marketplace/grants

```json
// byo 模板
{
  "siteSlug": "site-a",
  "templateKey": "example-claude",
  "channelName": "示例渠道",
  "byo": { "baseUrl": "https://upstream.example.com", "apiKey": "sk-example" },
  "groupIds": ["1"],
  "priority": 10
}
// managed 模板：不传 byo，编排器向计量网关申请 key 后注入
{ "siteSlug": "site-a", "templateKey": "market-claude", "groupIds": ["1"] }
```

响应含授权记录（引擎渠道 id、模板、状态）；任何响应不回明文 key。

### POST /api/marketplace/ledger/import

```json
{
  "grantId": 3,
  "rows": [
    {
      "periodStart": "2026-07-01T00:00:00Z",
      "periodEnd": "2026-07-02T00:00:00Z",
      "requests": 1000,
      "promptTokens": 2000000,
      "completionTokens": 500000,
      "upstreamCost": 8.0,
      "billedCost": 12.0
    }
  ]
}
```

账本按 `(grantId, periodStart, source)` 幂等 upsert；毛利 = `billedCost - upstreamCost`。

## 7. 告警（/api/alerts、/api/settings/alerts）

四种规则（语义详见 [OPERATIONS.md](OPERATIONS.md)）：`site_down`（critical）、`job_failed`、`channel_disabled`、`low_balance`（均 warning）。同 `(kind, siteId)` 最多一条 open。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/alerts?status=open|resolved|all` | 所有 | 默认 open；operator 只看 own 站 |
| POST | `/api/alerts/:id/resolve` | 写 | 手动关闭 |
| GET | `/api/settings/alerts` | root | 读通知配置 → `{ "webhookUrl": …, "alertEmailTo": … }`（未配置为 null） |
| PUT | `/api/settings/alerts` | root | `{ "webhookUrl"?: "https://hook.example.com/alerts", "alertEmailTo"?: "ops@example.com" }`；字段可选（未传不改），`""`/`null` 清除。邮件另需服务端 `RP_SMTP_*`（见 [SELF-HOST.md](SELF-HOST.md)） |

```json
// GET /api/alerts → 200
{
  "alerts": [
    {
      "id": 5,
      "kind": "site_down",
      "siteId": 7,
      "severity": "critical",
      "title": "站点不可达",
      "detail": "连续 3 次健康探测失败",
      "status": "open",
      "firstSeenAt": "2026-07-18 02:50:00.000",
      "lastSeenAt": "2026-07-18 03:00:00.000",
      "resolvedAt": null
    }
  ]
}
```

## 8. 计费与配额（/api/billing）

套餐决定 operator 可持有的非 destroyed 站点数；root/viewer 不受配额限制。无有效订阅时按 `free` 套餐配额。开通方式当前为 root 手工开通（支付网关为扩展位，见 ROADMAP）。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/billing/plans` | 所有 | 套餐列表 |
| GET | `/api/billing/subscription` | 所有 | 我的订阅 `{plan, periodEnd, quota, usedSites}` |
| GET | `/api/billing/subscriptions` | root | 全部订阅 |
| POST | `/api/billing/subscriptions` | root | 手工开通/顺延 `{operatorEmail, planKey, months}` |
| DELETE | `/api/billing/subscriptions/:id` | root | 取消（status=cancelled） |

内置套餐种子：`free`（1 站）/ `pro`（5 站）/ `scale`（20 站）。

## 9. 域名（/api/sites/:slug/domains）

域名写入 sites 行；配置了 `RP_CADDY_ADMIN_URL` 时同步下发到 Caddy（失败回滚 DB 并报错），详见 [CADDY.md](CADDY.md)。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/sites/:slug/domains` | 所有 | 域名列表 |
| POST | `/api/sites/:slug/domains` | 写 | `{ "domain": "api.example.com" }`（校验 `^[a-z0-9.-]+\.[a-z]{2,}$`） |
| DELETE | `/api/sites/:slug/domains` | 写 | 移除域名（`{ "domain": "api.example.com" }`） |

## 10. 指标（/metrics）

Prometheus 文本（`text/plain; version=0.0.4`）。两种访问方式：

- 面板会话（浏览器/登录后的 cookie）；
- `Authorization: Bearer <RP_METRICS_TOKEN>`（配置了 `RP_METRICS_TOKEN` 才生效，供 Prometheus 抓取，免 session）。

```
rp_sites_total{status="active"} 3
rp_site_up{slug="site-a"} 1
rp_jobs_total{status="failed"} 0
rp_alerts_open{severity="critical"} 0
rp_usage24h_cost{slug="site-a"} 12.5
```

`rp_site_up` / `rp_usage24h_cost` 来自站点快照缓存，抓取不会触发新的引擎探测。

## 11. curl 速查

```bash
# 登录并存 cookie
curl -c /tmp/rp.cookie -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"********"}' \
  http://127.0.0.1:7100/api/auth/login

# 带 cookie 调用
curl -b /tmp/rp.cookie http://127.0.0.1:7100/api/sites

# 写操作（非浏览器客户端不带 Origin，天然不受 CSRF 拦截）
curl -b /tmp/rp.cookie -X POST -H 'Content-Type: application/json' \
  -d '{"slug":"site-b","label":"示例站 B","engine":"sub2api","version":"1.2.3","adminEmail":"admin@example.com"}' \
  http://127.0.0.1:7100/api/sites

# Prometheus 抓取
curl -H 'Authorization: Bearer <RP_METRICS_TOKEN>' http://127.0.0.1:7100/metrics
```
