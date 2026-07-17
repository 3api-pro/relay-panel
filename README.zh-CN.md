<div align="center">

# relay-panel

**一套控制面，管理任意多个 LLM API 中转站。**

一键开站、升级、监控任意数量的自建 [sub2api](https://github.com/Wei-Shaw/sub2api) / [new-api](https://github.com/QuantumNous/new-api) 实例 —— 引擎零修改，全部从一个面板驱动。

[![License: MIT](https://img.shields.io/badge/License-MIT-3d5afe.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-43d17f.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-f0b74a.svg)](CONTRIBUTING.md)

[English](README.md) · **简体中文**

</div>

---

## 为什么做这个

基于开源引擎（sub2api / new-api）开一个 API 中转站门槛很低：拿到上游渠道、部署引擎、设好加价，就能开张。但**同时运营多个站**——不同品牌、不同客群、不同域名——就变成了重复的手工活：部署、升级、配置、灾备，每一样都要乘以站点数量和每次引擎发版。

relay-panel 把这些收敛成一个控制面：

```
┌────────────────── relay-panel 控制面 ──────────────────┐
│   站点生命周期    域名 + TLS    统一看板    渠道市场       │
├────────────────────── 引擎适配层 ──────────────────────┤
│        sub2api 适配器        │        new-api 适配器      │
├──────────────────── 数据面（每站独立隔离）──────────────┤
│   站 A: sub2api + PG   │  站 B: new-api + MySQL  │   …    │
└─────────────────────────────────────────────────────────┘
```

## 核心原则

1. **引擎永不修改。** sub2api / new-api 始终跑官方发行版，所有增值逻辑只存在于编排层，通过引擎自身的 admin API 实现。这让升级成本最小、许可证合规清晰（见 [docs/LICENSE-COMPLIANCE.md](docs/LICENSE-COMPLIANCE.md)）。
2. **每站一个独立实例。** 数据层不做共享多租户 —— 隔离干净、升级互不影响、任何站随时可作为标准引擎实例导出迁走。
3. **托管版与自部署版同一份代码。** 唯一区别是编排器跑在谁的服务器上。

## 两种用法

- **自部署（开源）：** 在自己的服务器上管理自己的站群。
- **托管 SaaS**（规划中）：注册即得一个站，无需服务器。

## 架构

完整设计与取舍见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。简言之：

- **`packages/adapter-core`** —— 引擎无关的领域类型 + `EngineAdapter` / `EngineLifecycle` 接口。
- **`packages/adapter-sub2api`** —— sub2api 实现（admin 引导、渠道/分组/用户/设置/用量）。
- **`packages/orchestrator`** —— Fastify + Drizzle 控制面：站点注册表、开站状态机、聚合看板。

## 状态与路线图

早期开发中。这是 v2 重写，与旧版 relay-panel（自研中继引擎路线）**不兼容**，旧代码完整保留在 [`legacy`](https://github.com/3api-pro/relay-panel/tree/legacy) 分支。

- [x] **P1 站群管家：** 编排器 + sub2api 适配层 + 站点生命周期（一键开站 / 升级带回滚 / 销毁）+ 只读统一看板（多站健康 / 上游 / 用量 / 成本聚合）
- [ ] **P2 引擎扩展 + 渠道市场：** new-api 适配层；上游渠道模板一键注入 + 分账
- [ ] **P3 管理后台：** 看板之上的写操作界面（开站 / 配置 / 用户 / 渠道）
- [ ] **P4 托管 SaaS：** 注册即开站、计费、配额

> 当前只提供**只读看板与命令行编排**，尚无 Web 管理后台。跟随 `main` 分支即可获取更新。

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

> 面向自部署者的一键 Docker 部署将随 P3 提供。目前编排器通过命令行 + 站点注册表文件驱动。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。**引擎适配层（`packages/adapter-*`）是外部贡献首选** —— 不含计费、上游路由、凭据逻辑，自包含且可独立测试，改错也不会波及生产计费或租户隔离。当前最有价值的独立任务是实现 **`adapter-newapi`**。

## 许可证

编排器本体为 MIT（见 [LICENSE](LICENSE)）。被编排的引擎遵循各自的许可证 —— new-api（[AGPL-3.0](https://github.com/QuantumNous/new-api)）、sub2api（[LGPL-3.0](https://github.com/Wei-Shaw/sub2api)）；relay-panel 仅通过它们的公开 admin API 调用，绝不打包或修改它们。
