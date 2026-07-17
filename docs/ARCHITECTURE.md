# 架构设计

状态：v2 初稿（2026-07-17）。adapter 细节以资产盘点结论为准持续修订。

## 0. 定位一句话

编排器（control plane）管理 N 个独立的引擎实例（data plane），引擎零修改，所有增值在编排层。

## 1. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 编排器后端 | TypeScript + Node 22+ / Fastify + Drizzle + PostgreSQL | 与团队既有栈（llmapi-v2 / mythos-v3）一致，adapter 可直接移植既有自动化脚本（jwtgen、admin API 封装） |
| 编排器前端 | Vue 3 + Vite + Tailwind | 与 sub2api 二开经验一致；UI 风格对标 Linear/Vercel 深色产品站 |
| 数据面 | Docker Compose（每站一个 compose 项目） | 隔离、可迁出、官方镜像即拉即用；生产目标 Linux |
| 反代/TLS | Caddy（编排器托管其配置） | 自动 HTTPS，按站点动态挂域名 |
| 发行 | 编排器自身打包为 docker image + compose 一键起 | 自部署体验 30 秒 |

Windows 本机开发用 Docker Desktop；生产面向 Linux VPS。

## 2. 领域模型

```
Operator (站长/租户)
 └── Site (站)  ── domain(s), plan, status
      └── EngineInstance ── engine(sub2api|newapi), version, ports, db_dsn, data_dir, admin_credential(加密)
           └── (引擎内部的 users/keys/channels 不镜像进编排器，按需经 adapter 实时读取)

ChannelTemplate (渠道市场条目) ── engine无关的抽象: 模型列表/协议/倍率建议/接入参数schema
 └── ChannelGrant (某站启用某渠道) ── 注入时生成站内 channel + 我方中间key, 计量回传

UsageLedger (渠道市场分账账本) ── grant_id, tokens, cost, period
```

要点：
- **编排器 DB 只存"站的元数据"与"渠道市场账本"**，不复制引擎内部业务表。引擎 DB 是各站的 single source of truth，编排器经 adapter 按需查询/写入。
- admin 凭据加密存储（libsodium sealed box），审计日志记录每次 adapter 写操作。

## 3. 引擎适配层（adapter）

每个引擎实现同一接口（包 `@relay-panel/adapter-core`）：

```ts
interface EngineAdapter {
  // 生命周期
  provision(spec: SiteSpec): Promise<InstanceInfo>;   // 生成 compose 项目+config, 起容器, 初始化 admin
  upgrade(inst: InstanceInfo, toVersion: string): Promise<void>;
  destroy(inst: InstanceInfo, opts: { keepData: boolean }): Promise<void>;
  health(inst: InstanceInfo): Promise<HealthReport>;

  // admin API 封装（引擎差异在此抹平）
  auth(inst: InstanceInfo): Promise<AdminSession>;    // sub2api: 自签JWT; newapi: session/token
  channels: ChannelOps;   // list/create/update/test —— 渠道市场注入的落点
  groups: GroupOps;
  users: UserOps;
  settings: SettingsOps;  // 站点品牌/公告/开关
  stats: StatsOps;        // 用量/余额 → 统一看板
}
```

设计约束：
- adapter 只调用引擎**公开 admin API**（HTTP），不直连引擎 DB —— 除非该引擎无对应 API 且有已验证的安全 SQL 路径（须在 adapter 内显式标注 `dbDirect: true` 并附迁移风险说明）。
- 引擎版本差异用 capability flags 处理（如 sub2api ≥0.1.158 才有用户侧 PAT）。
- adapter 是社区贡献的主战场（不含商业逻辑，issue #1 的答案）。

## 4. 生命周期编排（provisioner）

开一个站 = 幂等状态机：

1. 分配端口/子域 → 2. 渲染 compose + 引擎 config 模板 → 3. `docker compose up -d` → 4. 等健康检查 → 5. 引擎初始化（建 admin、写站点品牌设置）→ 6. Caddy 挂域名 → 7. 站点标记 active

升级 = 拉新镜像 → 滚动重建容器（数据卷不动）→ 健康检查 → 失败自动回滚到旧 image tag。
每步落审计事件，失败可从任意步重入（状态机存 DB）。

## 5. 渠道市场（商业内核）

- ChannelTemplate 定义"上游渠道产品"：支持的模型、协议(anthropic/openai/responses)、建议倍率、需要的接入参数。
- 站长点启用 → 编排器向**我方渠道网关**申请签发一把该站专属的中间 key → 经 adapter 在站内创建 channel 指向渠道网关 → 用量在网关侧按 key 计量 → UsageLedger 分账。
- 渠道网关本身复用现有上游路由体系，不在本仓库内（闭源、独立部署）。开源自部署版中渠道市场是可关闭的插件，指向我方注册服务。
- 站长永远可以手工配自己的上游 —— 渠道市场是推荐位，不是锁定。

## 6. 安全边界

- 编排器 admin 面板与站点公网面完全分离（不同端口/域名，面板默认仅内网+SSO）。
- adapter 持有的引擎 admin 凭据 = 最高权限，凭据只在编排器进程内存中解密使用，绝不落日志/回显（团队铁律）。
- 多租户托管版：Operator 之间强隔离，每个 Operator 只能看到自己站的实例信息；容器网络按站隔离。

## 7. 阶段规划

- **P1 站群管家（当前）**：单机版编排器 + sub2api adapter（provision/upgrade/health/统一看板）。第一个用户是我们自己（4 个生产站 + demo 站）。验收：在本机 Docker 里从零一键开出一个 sub2api demo 站并注入测试渠道。
- **P2 newapi adapter + 渠道市场 alpha**：接入现有上游做分账闭环，先在自己站群跑通。
- **P3 开源发布**：清理、文档、compose 一键包；回复 issue #1 公布贡献指南。
- **P4 托管 SaaS**：注册开站、计费、配额。P1-P3 验证后才动。
