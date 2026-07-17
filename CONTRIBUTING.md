# 贡献指南 / Contributing

感谢关注 relay-panel。本项目正处于 v2 重写阶段（多站编排框架），架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 哪里最适合外部贡献？（Where is it safe to contribute?）

relay-panel 刻意把系统分成三层，**风险从低到高**：

| 层 | 目录 | 敏感度 | 适合外部贡献 |
|---|---|---|---|
| **引擎适配层** | `packages/adapter-*` | 低 | ✅ **首选** |
| 编排/生命周期 | `packages/orchestrator/src/provision` | 中 | ⚠️ 需讨论 |
| 计费 / 渠道市场 / 凭据 | orchestrator 商业逻辑 | 高 | ❌ 暂由核心维护 |

**引擎适配层（`packages/adapter-*`）是外部贡献的主战场**，原因：

- 它不含任何计费、上游路由、凭据或多租户逻辑 —— 只是把某个开源引擎（sub2api / new-api）的 admin API 封装成统一的 `EngineAdapter` 接口（见 `packages/adapter-core`）。
- 每个 adapter 是自包含的、可独立测试的，改错了也不会波及生产计费或租户隔离。
- 这里最缺的正是**广度**：目前只有 `adapter-sub2api`，`adapter-newapi` 待实现，未来还会有更多引擎。

### 具体的好上手方向

1. **`adapter-newapi`**：照着 `adapter-sub2api` 的形状，为 [new-api](https://github.com/QuantumNous/new-api) 实现 `EngineAdapter` / `EngineAdminClient`。这是当前最有价值的独立任务。
2. **adapter 契约测试**：针对 `adapter-core` 接口写引擎无关的一致性测试（协议兼容、分页、错误信封）。
3. **文档 / 部署示例**：compose 模板、各引擎的接入说明。

计费、渠道市场分账、凭据加密、租户隔离这些"最锋利"的部分暂由核心维护者负责 —— 不是不欢迎，而是它们直接关系到生产资金安全，需要更重的评审。有想法欢迎先开 issue 讨论。

## 铁律

- **引擎零修改**：adapter 只经引擎公开的 admin API（HTTP）操作引擎，不 import 引擎代码、不直连引擎 DB（除非该引擎无对应 API 且路径已在 adapter 内显式标注风险）。理由见 [docs/LICENSE-COMPLIANCE.md](docs/LICENSE-COMPLIANCE.md)。
- **凭据不落痕**：admin 凭据、API key、密码绝不写入日志、报错信息或提交内容。
- 提交前跑 `npm run typecheck` 与 `npm test`。

## 开发

```bash
npm install
npm run typecheck
npm test
```
