<div align="center">

# relay-panel

**一套控制面，管理任意多个 LLM API 中转站。**

接入、管理、监控任意数量的自建 [sub2api](https://github.com/Wei-Shaw/sub2api) / [new-api](https://github.com/QuantumNous/new-api) 实例 —— 引擎零修改，全部从一个面板驱动。

[![License: MIT](https://img.shields.io/badge/License-MIT-3d5afe.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-43d17f.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![在线演示](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E6%BC%94%E7%A4%BA-demo.3api.pro-6d8bff.svg)](https://demo.3api.pro)

[English](README.md) · **简体中文** — [**在线演示 →**](https://demo.3api.pro)

<br/>

<img src="docs/media/overview-dark.jpg" alt="relay-panel 站群总览" width="880" />

</div>

---

## 为什么做这个

基于开源引擎（sub2api / new-api）开一个 API 中转站门槛很低：拿到上游渠道、部署引擎、设好加价，就能开张。但**同时运营多个站**——不同品牌、不同客群、不同域名——就变成了重复的手工活：部署、升级、配置、灾备，每一样都要乘以站点数量和每次引擎发版。

relay-panel 把这些收敛成一个控制面：

```
┌───────────────────── relay-panel 控制面 ──────────────────────┐
│  Web 管理后台(Vue SPA) · 认证/RBAC/审计 · 任务引擎 · 告警      │
│  站点生命周期 · 渠道市场+账本 · 计费配额 · 域名自动化          │
├───────────────────────── 引擎适配层 ──────────────────────────┤
│        sub2api 适配器         │        new-api 适配器          │
├──────────────────── 数据面（每站独立隔离）────────────────────┤
│   站 A: sub2api + PG   │   站 B: new-api + DB   │      …       │
└───────────────────────────────────────────────────────────────┘
```

## 功能

- **自部署与已有站点接入** —— 通过自部署版面板在本机安装和管理引擎，也可通过地址和管理凭据接入已有站点。平台不提供中转站硬件或服务器租赁；存量本地托管站点保留生命周期管理。
- **Web 管理后台** —— Vue 3 SPA：站群总览、单站钻取（渠道 / 用户 / 用量 / 域名 / 审计）、任务时间线。液态玻璃界面，明/暗双主题，**10 国语言 i18n**（English / 中文 / 日本語 / 한국어 / Français / Deutsch / Español / Português / Italiano / Bahasa Indonesia）。
- **多引擎、零修改** —— sub2api 与 new-api 收敛到同一套适配接口，引擎始终跑官方发行版。
- **渠道市场** —— 上游渠道模板一键注入任意站点（站长自带上游，或由计量网关签发 managed key），配套用量/结算账本。
- **告警** —— 站点不可达 / 任务失败 / 渠道被禁 / 余额过低，以及毛利过低、成本突增；配置后通过邮件或 webhook 通知。
- **多租户 RBAC** —— 按站长隔离站点，支持开放/邀请注册、session 认证与写操作审计；root 管理平台，viewer 为平台全局只读角色，不是客户组织成员。
- **计费与配额** —— 支持支付宝 / 微信 / USDT 自助支付、到账后开通恢复；升级按剩余时间补差价，降级到当前周期结束后生效。
- **域名自动化** —— 面板里绑域名，路由经 Caddy admin API 下发，TLS 自动签发。
- **可观测** —— Prometheus `/metrics`、健康探测、结构化审计流水。
- **备份/恢复** —— 一条命令导出编排器状态 + 每站数据库。
- **一键部署** —— `deploy/` 目录 `docker compose up -d`。

## v2.10.0：可复核的引擎用户限额

管理员可从预算页或风控页直接配置 Sub2API 用户平台限额。每次执行绑定十分钟有效的预览，先保存执行意图、检查配置冲突，再写入并独立回读；重复提交不重复写入，超时或结果不一致会保留待复核记录并阻止同一用户继续写入。支持回读与带处理意见的差异关闭，缺失字段不会当成“不限额”。

该能力适用于上游标准运行模式的余额计费，订阅流量与简易模式不在覆盖范围；日、周按引擎时区，月为 30 天，与面板自然周期预算独立。回读一致只证明当时配置相符，不证明实际拦截或零超额。写入默认关闭（`RP_RISK_ENFORCE=1` 才可启用），只读站点仍拒绝写入。旧限额调用需先预览，再提交 `operationId` 与适用范围确认；不再接受直接携带金额执行。

## v2.9.0：客服工单授权与内部备注

平台管理员可把单条支持工单分配给已有且邮箱已验证的普通账号，分别授权回复、结单及内部备注，最长 90 天。客服只能查看分配的客户对话，不继承客户身份字段、站点或财务权限；内部备注不会进入客户消息或通知。新增标题搜索、状态筛选和完整历史分页，回复、通知及撤销通过事务校验。

## v2.8.0：按范围授权的财务协作

站长可向财务协作者单独授权固定日期、渠道和模型范围，分别控制上游成本、消费明细、CSV 导出及复核权限。汇总复用已存日志，保留金额未知与采集缺口；提交时留存快照，由站长确认或退回。授权收窄后协作者不能读取旧版快照，既有邀请不自动获得财务访问权，复核不会触发支付或修改引擎余额。

## v2.7.0：被动预算与阈值提醒

复用已有消费日志，按站点、渠道、模型跟踪日、周、月预算，分别显示金额缺失、采集覆盖和已观测阈值。支持版本化事件、站长可选通知、一次性复核说明及每日 CSV 导出；不探测模型、不停用渠道、不改余额，也不自动执行引擎限额。

## v2.6.0：客户知识库与模型能力记录

按站点维护接入指南、常见问题、操作手册和模型能力说明。草稿与历史不公开，站长预览后发布独立版本，可撤回或将历史内容恢复为新草稿。模型支持结论需记录验证日期、引擎版本与依据，未验证能力保持未知，面板不发送额外推理探测。

## v2.5.0：按事项授权的协作工作台

新增供应商、代理、运维、客服和财务协作身份，使用绑定邮箱的一次性邀请。站点方单独编写共享标题和说明，协作者可回复、提交结果，由站点方复核；不继承内部证据、成本、密钥或工作区权限。授权最长90天且可立即撤销。受邀者须已有账号并验证邮箱，邀请链接由站点方自行发送，不会自动发邮件。

## v2.4.0：站点服务中心

从真实请求日志分析渠道质量与费用，连接故障事件、客服工单、合作伙伴、报价结算和运维交付。默认不发送模型心跳或合成测试调用；无流量和缺失字段显示为未知，明确标注样本及来源覆盖。

新增请求诊断与证据导出、八类事项检查清单与处理历史、上游/代理/代运维档案、客户端配置向导、可预览及撤回的公开状态公告。自动采集可按站点暂停，伙伴档案不自动授予外部权限，结算不会自动划款。

[服务说明](docs/SERVICE-CENTER.md) · [三轮方案审议与实施规划](docs/SERVICE-PLATFORM-PLAN.md) · [发布说明](docs/releases/v2.4.0.md)

## v2.2.0 更新

[完整发布说明](docs/releases/v2.2.0.md)

- 用户工作区与管理员功能分组，手机端导航同步整理。
- 接入已有站点自动分配内部标识，用户只需填写可随时修改的备注名。
- 支付恢复与套餐变更报价冻结；财务披露数据缺口，区分消费记账、上游成本与现金充值。
- 管理员可按请求查看财务证据、去重复核、记录处置依据并重新核验。详见[计费规则](docs/BILLING.md)与[财务复核](docs/FINANCE-REVIEW.md)。

**匿名实战案例：** 一封毛利过低警告邮件触发排查，确认旧版 Sub2API 的结算漏洞被批量利用，出现“上游已消耗、用户未正常扣费”的异常。告警帮助定位问题并推动引擎升级修复（[上游修复](https://github.com/Wei-Shaw/sub2api/commit/c2d5bbd93edfb3a14f7da28d2e62c9216f0bbc86)）。不披露真实站点、账号、金额和私有日志；面板负责监测与复核，引擎修复需单独部署。

## 截图

> 在线体验 **[demo.3api.pro](https://demo.3api.pro)** —— 只读演示、示例数据、定期重置。

<table>
<tr>
<td width="50%"><img src="docs/media/site-detail.jpg" alt="单站钻取与用量趋势" /><br/><sub>单站钻取 —— 渠道、用户、用量趋势、域名、审计</sub></td>
<td width="50%"><img src="docs/media/marketplace.jpg" alt="渠道市场" /><br/><sub>渠道市场 —— 模板、授权、结算</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/ledger.jpg" alt="分账账本" /><br/><sub>分账账本 —— 用量、上游成本、毛利</sub></td>
<td width="50%"><img src="docs/media/alerts.jpg" alt="告警" /><br/><sub>告警 —— 站点不可达 / 任务失败 / 渠道被禁 / 余额过低</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/media/overview-light.jpg" alt="浅色主题" /><br/><sub>浅色主题</sub></td>
<td width="50%"><img src="docs/media/billing-light.jpg" alt="计费与配额" /><br/><sub>计费与配额 · 套餐与订阅</sub></td>
</tr>
</table>

## SaaS 运营能力

支持邮箱验证与找回密码、身份验证器 MFA 与恢复码、登录设备撤销、团队工作区、通知偏好、支持工单、退款审批与账单、面板定时备份、审计导出、供应商对账与历史费率估算。配置、能力边界和验收记录见 [SaaS 运维指南](docs/SAAS-OPERATIONS.md)。退款需在支付渠道完成并登记真实回执，面板不会自动划款。

套餐仅提供面板管理服务，不包含硬件、服务器、上游 API 用量或引擎数据备份。

## 核心原则

1. **引擎永不修改。** sub2api / new-api 始终跑官方发行版，所有增值逻辑只存在于编排层，通过引擎自身的 admin API 实现。这让升级成本最小、许可证合规清晰（见 [docs/LICENSE-COMPLIANCE.md](docs/LICENSE-COMPLIANCE.md)）。
2. **每站一个独立实例。** 数据层不做共享多租户 —— 隔离干净、升级互不影响、任何站随时可作为标准引擎实例导出迁走。
3. **托管版与自部署版同一份代码。** SaaS 禁止新建服务器实例；自部署版可通过面板在自己的机器安装和管理引擎。

## 快速开始

```bash
git clone https://github.com/3api-pro/relay-panel.git
cd relay-panel/deploy
cp .env.example .env   # 设置 RP_SECRET_KEY、RP_ADMIN_EMAIL、RP_ADMIN_PASSWORD
docker compose up -d
```

打开 `http://<服务器>:7100` 登录。完整指南（env 全表、反代、升级、备份、旧版 Basic Auth 迁移）：**[docs/SELF-HOST.md](docs/SELF-HOST.md)**。

开发态：

```bash
npm install
npm run typecheck
npm test
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/SELF-HOST.md](docs/SELF-HOST.md) | 部署、配置、升级、备份 |
| [docs/API.md](docs/API.md) | HTTP API 全表 |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | 适配层接口 + 新引擎接入 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 监控、告警、备份恢复、故障排查 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、凭据加密、RBAC、漏洞上报 |
| [docs/METERING-GATEWAY.md](docs/METERING-GATEWAY.md) | 渠道市场计量网关 HTTP 契约 |
| [docs/CADDY.md](docs/CADDY.md) | Caddy 域名自动化 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计与取舍 |

## 架构

- **`packages/adapter-core`** —— 引擎无关的领域类型 + `EngineAdapter` / `EngineLifecycle` 接口。
- **`packages/adapter-sub2api`** / **`packages/adapter-newapi`** —— 引擎实现（admin 认证、渠道/分组/用户/设置/用量）。
- **`packages/orchestrator`** —— Fastify + Drizzle 控制面：站点、任务、认证/RBAC、市场+账本、告警、计费、域名、metrics、CLI。
- **`packages/web`** —— Vue 3 + Vite + Tailwind 管理后台 SPA。

## 状态与路线图

这是 v2 重写，与旧版 relay-panel（自研中继引擎路线）**不兼容**，旧代码完整保留在 [`legacy`](https://github.com/3api-pro/relay-panel/tree/legacy) 分支。

- [x] **P1 站群管家：** 编排器 + sub2api 适配层 + 站点生命周期 + 只读统一看板
- [x] **P2 引擎扩展 + 渠道市场：** new-api 适配层；渠道模板、授权注入、计量/结算账本
- [x] **P3 管理后台：** 操作员账号 + RBAC、全量写操作界面、告警、一键 Docker 部署
- [ ] **P4 托管 SaaS 验收：** 七项核心能力均已实现，包含自助支付与接入已有站点；完整交付链路和运营验收仍待收尾，详见[当前差距评估](docs/P4-READINESS.md)。

里程碑范围与验收标准见 [ROADMAP.md](ROADMAP.md)。

## 赞助商

relay-panel 的开发由这些 LLM API 中转平台支持 —— 它们正是本项目所编排引擎的生产用户：

<table align="center">
<tr><td align="center" width="520">
<a href="https://llmapi.pro"><b>llmapi.pro</b></a> —— 多模型 LLM API 中转 · Claude · GPT · Gemini 等
</td></tr>
<tr><td align="center" width="520">
<a href="https://tieapi.com"><b>tieapi.com</b></a> —— 高可用 API 网关，面向团队与开发者
</td></tr>
<tr><td align="center" width="520">
<a href="https://vipapi.ai"><b>vipapi.ai</b></a> —— 灵活套餐的高端 LLM API 服务
</td></tr>
</table>

有意赞助？欢迎提 [issue](https://github.com/3api-pro/relay-panel/issues)。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。**引擎适配层（`packages/adapter-*`）是外部贡献首选** —— 不含计费、上游路由、凭据逻辑，自包含且可独立测试，改错也不会波及生产计费或租户隔离。想接入新引擎？照 [docs/ADAPTERS.md](docs/ADAPTERS.md) 一步步来。

## 许可证

编排器本体为 MIT（见 [LICENSE](LICENSE)）。被编排的引擎遵循各自的许可证 —— new-api（[AGPL-3.0](https://github.com/QuantumNous/new-api)）、sub2api（[LGPL-3.0](https://github.com/Wei-Shaw/sub2api)）；relay-panel 仅通过它们的公开 admin API 调用，绝不打包或修改它们。
