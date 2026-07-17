# 引擎适配层指南（Adapters）

relay-panel 的一切引擎操作都经过 `packages/adapter-core` 定义的两个接口：**EngineAdapter**（运行中的引擎 admin API）与 **EngineLifecycle**（宿主机上的实例生命周期）。想给 relay-panel 接一个新引擎，只需要实现这两个接口——这是外部贡献的推荐入口：不含计费、上游路由、凭据存储逻辑，自包含、可独立测试。

铁律（详见 [LICENSE-COMPLIANCE.md](LICENSE-COMPLIANCE.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md)）：

1. **引擎零修改**——只经引擎公开 admin API（HTTP）操作；直连引擎 DB 必须显式声明 `dbDirect: true` 并注明风险。
2. **凭据只经 `CredentialStore` 内存解密使用**，绝不落日志、落盘、回显。
3. adapter 不含渠道市场等商业逻辑——那些在 orchestrator 层。

## 1. 领域类型（types.ts）

adapter 的职责是把引擎私有概念映射到这些引擎无关类型；映射不了的私有能力走 capability flag + `raw` 字段透传，不污染公共类型。

| 类型 | 作用 |
|---|---|
| `EngineKind` | `'sub2api' \| 'newapi'`（接新引擎需扩这个联合类型） |
| `SiteSpec` | provision 输入：slug、engine、钉死的 version（禁 `latest`）、domains、hostPort、数据库接入、初始 admin、品牌 |
| `InstanceInfo` | provision 产物：定位一个活实例所需的一切（baseUrl、dataDir、composeProject、credentialRef）——**不含凭据本体** |
| `CredentialStore` / `EngineCredential` | 凭据解析回调，orchestrator 注入。`kind`: `admin-password`（密码+adminEmail）/ `admin-token`（长期 key）/ `jwt-secret` |
| `ChannelSpec` / `ChannelRecord` | 引擎无关的"渠道"（上游接入）：name、protocol（`anthropic \| openai \| openai-responses \| gemini`）、baseUrl、apiKey、models、modelMapping、groups、priority、weight、raw。Record 额外含 id、enabled，且 `apiKey` 恒 `'<redacted>'` |
| `GroupSpec` / `GroupRecord` | 分组 + 倍率 ratio |
| `SiteUserRecord` | 站内用户（id/email/username/role/balance/status） |
| `SiteBranding` | siteName / logoUrl / announcement |
| `UsageSummary` | 用量窗口聚合：requests、promptTokens、completionTokens、cost、costUnit、byModel |
| `HealthReport` | ok / httpOk / dbOk? / version? / latencyMs / detail |
| `EngineCapabilities` | 见 §4 |

## 2. EngineAdapter 逐方法

```ts
interface EngineAdapter {
  readonly engine: EngineKind;
  readonly dbDirect: boolean;           // 是否有绕过 admin API 直连引擎 DB 的路径
  capabilities(inst): Promise<EngineCapabilities>;
  health(inst): Promise<HealthReport>;
  connect(inst, credentials): Promise<EngineAdminClient>;
}
```

- **`capabilities(inst)`**：声明该引擎（该版本）支持哪些可选能力，orchestrator/前端据此裁剪功能入口。可按 `inst.version` 分支。
- **`health(inst)`**：轻量健康探测（告警引擎每分钟打一次），必须**不依赖凭据**、快速失败（现有实现 8s 超时）、绝不抛异常——失败以 `{ok:false, detail}` 表达。
- **`connect(inst, credentials)`**：建立 admin 会话（登录换 token / 自签 JWT / 长期 key 直用……），返回已认证的 `EngineAdminClient`。会话缓存与续期由 adapter 内部负责。connect 应当是**非破坏性**的：不得轮换/作废站点既有凭据（重复 connect 不能自相踩踏）。

### EngineAdminClient 五组能力

```ts
client.channels  // list / create / update(含 enabled 启停) / remove / test
client.groups    // list / create / update
client.users     // list(search/page) / setStatus
client.settings  // getBranding / setBranding / getRaw / setRaw
client.stats     // usage(from, to)
```

实现要点（从现有两个 adapter 提炼的通则）：

- `channels.list` 返回的 `apiKey` 一律填 `'<redacted>'`——脱敏在 adapter 层就完成，不指望上层。
- `channels.create` 若引擎的创建接口不回显完整记录，创建后**回读**拿权威数据再返回。
- `channels.update` 注意引擎的"整体替换"语义：先 GET 现状、合并 patch、再写回，避免部分更新清掉未提及字段。
- `settings` 同理：引擎设置接口若是整包替换，必须读-合并-全量写回。
- `stats.usage` 把引擎记账口径归一：`costUnit` 注明货币；引擎不区分 prompt/completion 时按约定放到 `completionTokens`（求和口径保持正确）。
- 所有方法失败抛普通 `Error`，消息里**不得**包含凭据；上层负责翻译成用户可见错误。

## 3. EngineLifecycle 逐方法

```ts
interface EngineLifecycle {
  readonly engine: EngineKind;
  provision(spec: SiteSpec): Promise<InstanceInfo>;
  upgrade(inst, toVersion): Promise<InstanceInfo>;
  stop(inst): Promise<void>;
  start(inst): Promise<void>;
  destroy(inst, { keepData }): Promise<void>;
}
```

与 EngineAdapter 分离的原因：lifecycle 操作宿主机（docker、文件系统），adapter 操作引擎 HTTP API——**权限面不同**。

- **`provision`**：渲染 compose 与配置 → 起容器 → 等健康 → 初始化 admin 账号 → 写品牌。要求**幂等**：同 slug 重入从断点续做。生成的引擎 admin 凭据经 orchestrator 注入的 `storeCredential` 回调加密入库（lifecycle 自身不落盘明文）。引擎镜像**钉版本**（`latest` 在上游被拒）。
- **`upgrade`**：换 image tag 重起，失败自动回滚旧 tag；数据卷不动。
- **`stop` / `start`**：compose 级停起。
- **`destroy`**：拆容器；`keepData: true` 保留数据卷（站点可导出为标准引擎实例迁走）。

现有实现：`packages/orchestrator/src/provision/` 下 `sub2apiLifecycle.ts` / `newapiLifecycle.ts` + 对应 `*Compose.ts` 模板 + `docker.ts`（compose 驱动，支持经 WSL 调 docker 的开发形态）。引擎 compose 内部只用命名卷。

## 4. Capability flags

```ts
interface EngineCapabilities {
  userAccessTokens: boolean;     // 用户侧个人访问令牌
  multiGroupKeys: boolean;       // 一把 API key 绑多个分组
  anthropicNative: boolean;      // anthropic 原生协议分发
  subscriptionBilling: boolean;  // 站内订阅/套餐计费
}
```

原则：公共接口只收录**两个以上引擎有共同语义**的能力；单引擎独有能力走 `raw` 透传 + capability flag 声明，orchestrator/前端按 flag 显隐入口，绝不在公共类型里堆引擎私货。新增 flag 时给所有现有 adapter 补上取值（缺省视为 false 的语义设计）。

## 5. 现有两个 adapter 的映射概览

以下均以官方开源版行为为准（源码：`packages/adapter-sub2api`、`packages/adapter-newapi`）。

### 5.1 sub2api

| adapter-core 概念 | sub2api 落点 |
|---|---|
| Channel（上游接入） | **account**（上游凭证）+ group 挂载。sub2api 自己的"channel"是计费/展示概念，不在映射内（经 raw 透传可用） |
| Channel.enabled | account `status: active/inactive` |
| Group | group（倍率字段 `rate_multiplier`） |
| users | `/api/v1/admin/users`（分页） |
| Branding | settings 的 `site_name` / `site_logo` |
| Usage | `/api/v1/admin/usage/stats`（区分 input/output tokens，口径 USD） |

认证：`admin-token`（长期 admin-api-key，推荐生产凭据，直接作 api-key 头）或 `admin-password`（登录换 JWT 做 bearer + 合规确认；**不** regenerate 站点既有 admin-api-key）。

实现细节（踩坑固化）：

- 账号更新带 credentials 必须**全量**（apiKey 与 baseUrl 同时给），部分更新会清掉 base_url——adapter 对只给一半的 patch 直接抛错。
- openai 协议渠道默认显式关闭 responses 探测（`openai_responses_supported: false`），中转类上游大多不支持。
- settings 的 PUT 是整包替换：读-合并-全量写回；GET 不回显秘密（PUT 空秘密字段=保留旧值），该往返是安全的。
- create account 的响应不含 group_ids，创建后回读。

### 5.2 new-api

| adapter-core 概念 | new-api 落点 |
|---|---|
| Channel | channel；protocol → type 枚举：openai=1、anthropic=14、gemini=24、openai-responses=57 |
| Channel.models / groups | 逗号分隔字符串（adapter 负责数组互转） |
| Channel.enabled | 独立端点 `POST /api/channel/:id/status`（1=启用 2=禁用；bulk PUT 不接受 status 字段） |
| Group | option `GroupRatio` JSON 的键（`GET /api/group/` 只给名字数组，倍率从 GroupRatio 读写） |
| users | `/api/user/` 与 `/api/user/search`；balance = quota / 500000（1 USD = 500000 quota） |
| Branding | options `SystemName` / `Logo` / `Notice`（**需 root 权限**，非 root 403） |
| Usage | `/api/data/` 按模型聚合；不区分 prompt/completion（总 token 放 completionTokens），cost = quota / 500000 |

认证：`admin-token`（access_token + userId 双头，userId 放 `extra.userId`）或 `admin-password`（用户名密码登录直接用 session cookie；非破坏性，不铸/不轮换 access_token）。

实现细节：

- channel 更新走"读-合并-写回干净标量子集"：GET 会把部分字段返回为 null，整包回写会失败；key 明文 GET 拿不到（脱敏为空），只有显式改 key 时才发送。
- create channel 不回显创建结果，按名字回读定位最新一条。

## 6. 新引擎接入步骤

1. **建包**：`packages/adapter-<engine>/`，参考 `adapter-newapi` 的结构（`http.ts` 请求封装 / `auth.ts` 登录与会话 / `adapter.ts` 实现 / `index.ts` 导出）。依赖仅 `@relay-panel/adapter-core`，不新增运行时依赖。
2. **扩类型**：`adapter-core/src/types.ts` 的 `EngineKind` 联合加新值（这是唯一需要动 adapter-core 的地方）。
3. **实现 EngineAdapter**：先做 `health` + `connect` + 只读五组（channels.list/groups.list/users.list/getBranding/usage），再补写操作。写操作前先用只读版本对着一个一次性测试实例核对映射。
4. **实现 EngineLifecycle**：`packages/orchestrator/src/provision/` 加 `<engine>Compose.ts`（compose 渲染模板，数据库/引擎钉版本、命名卷）与 `<engine>Lifecycle.ts`（provision 状态机：render → up → health → admin init → branding）。
5. **注册**：`provision/index.ts` 的 `makeLifecycles` 与 server 装配处的 adapters 映射各加一行。
6. **capability flags**：如实声明四个 flag；引擎私有能力走 `raw`。
7. **测试**：vitest 单测（用录制的 HTTP fixture / fake server，不连真实例）；E2E 用一次性本地实例走通 渠道增删改查 + 分组 + 用户 + 品牌 + 用量。测试快照里不得出现任何真实凭据。
8. **文档**：本文件 §5 加映射概览一节。

提交 PR 前检查：`npm run typecheck`、`npm test` 全绿；grep 确认无凭据、无真实站点信息入库（示例一律 `site-a` / `example.com`）。
