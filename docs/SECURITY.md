# 安全设计（Security）

本文描述 relay-panel 编排器的安全边界与实现细节：威胁模型、凭据加密、会话与 CSRF、RBAC、以及漏洞上报渠道。

## 1. 威胁模型

### 1.1 需要保护的资产

| 资产 | 存放位置 | 泄露后果 |
|---|---|---|
| 各站引擎 admin 凭据（密码 / admin key） | `credentials` 表（AES-256-GCM 密文） | 单站完全接管 |
| 计量网关 token 与签发的渠道 apiKey | env / 注入引擎后由引擎持有 | 冒用计量、上游费用损失 |
| 操作员密码 | `operators.password_hash`（scrypt） | 面板账号接管 |
| 会话 token | 仅 cookie 持有明文，DB 存 sha256 | 会话劫持 |
| 主密钥 `RP_SECRET_KEY` | env | 全部 enc: 凭据可解 |
| 审计/账本数据 | 编排器 DB | 商业信息泄露 |

### 1.2 对手与边界

- **外部未认证攻击者**：面对登录页与公开端点。防线：统一登录错误文案 + 登录时序均衡（不存在的账号也跑一次 scrypt）、注册默认关闭（`RP_SIGNUP_MODE=closed`）、session cookie httpOnly、CSRF 校验、`/metrics` 需 token。
- **低权限租户（operator/viewer）**：已登录但试图越权。防线：RBAC + 站点归属校验（`canAccessSite`），无权站点统一回 404 不泄露存在性；viewer 一切写操作 403；jobs/alerts/ledger 全部按归属过滤。
- **被攻破的站点引擎**：单站引擎被拿下。防线：每站独立容器与独立数据库，站间无共享数据面；编排器持有的该站凭据只能操作该站；引擎无法反向调用编排器（编排器不暴露供引擎回调的接口）。
- **网络窃听者**：防线：生产部署要求 HTTPS 反代（面板自身默认监听 127.0.0.1）；cookie 不含敏感数据只含随机 token。
- **拿到 DB 备份的人**：防线：凭据全部密文（无 `RP_SECRET_KEY` 不可解）；密码 scrypt；session 只存 hash。DB 备份与主密钥必须分开存放（见 [OPERATIONS.md](OPERATIONS.md)）。

### 1.3 明确不在防御范围内

- 拿到宿主机 root / docker.sock 的攻击者（等同拿下一切——docker.sock 挂载是部署的信任前提）。
- 拿到 `RP_SECRET_KEY` + DB 的攻击者。
- 引擎自身的漏洞（引擎零修改原则下，跟随官方版本升级，见 ROADMAP 的引擎钉版本策略）。

## 2. 凭据加密（enc: 方案）

实现：`packages/orchestrator/src/secrets.ts`。

- 算法：**AES-256-GCM**，每次加密随机 12 字节 IV，16 字节认证 tag。
- 密文格式：`v1:` + base64(IV ‖ tag ‖ ciphertext)，存 `credentials.ciphertext`，主键为完整 ref（如 `enc:site-a`）。
- **密钥派生**（`RP_SECRET_KEY`）：
  - 值恰为 64 位 hex → 直接作为 32 字节 key（推荐，`openssl rand -hex 32` 生成）；
  - 否则 → `sha256(utf8(RP_SECRET_KEY))` 派生 32 字节 key。
- 解密失败（密钥不对/密文被篡改）抛统一错误，不透出底层细节。
- 明文只在进程内存中短暂存在：开站时 lifecycle 生成的引擎 admin 凭据 JSON 直接加密入库；使用时按 ref 解密、构造引擎客户端后即弃。
- 未设置 `RP_SECRET_KEY` 时：服务可启动，但 enc: 凭据解析与面板开站报错（功能性降级而非静默）。

配套纪律（代码层强制）：

- 审计 payload 一律过 `redact()`：key 名匹配 `/key|secret|password|token|credential|apikey/i` 的字段整值替换为 `<redacted>`（宁可多杀）。
- 任务步骤 detail 与失败 error 过 `redactText()` 文本脱敏。
- API 响应中引擎渠道的 `apiKey` 恒为 `"<redacted>"`，无论引擎返回什么。
- 邀请 token、session token 等一次性明文只在创建响应出现一次；列表只回前缀。

## 3. 密码存储

实现：`packages/orchestrator/src/auth/passwords.ts`。

- **scrypt**（node:crypto），参数 N=16384、r=8、p=1，随机 16 字节 salt。
- 存储格式：`scrypt:N=16384,r=8,p=1:<salt hex>:<hash hex>`（参数随 hash 存储，未来可升参数平滑迁移）。
- 校验用 `timingSafeEqual`；登录时对不存在的账号也执行一次 scrypt（时序均衡），失败文案统一"邮箱或密码错误"。

## 4. 会话与 CSRF

实现：`auth/sessions.ts` + `server.ts` 钩子。

### 4.1 session

- token：32 字节 CSPRNG，hex 编码；**DB 只存 sha256(token)**，拿到 DB 也无法伪造会话。
- cookie：`rp_session`，`httpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age` = TTL。不设 `Secure` 标志（自部署常见 http 内网/localhost 场景），**生产 HTTPS 由反代层终止**——反代务必只在 443 对外。
- TTL：`RP_SESSION_TTL_HOURS`（默认 168h）；剩余寿命 < TTL/2 时滑动续期。
- 吊销：登出删当前会话；改密吊销除当前外全部会话；root 禁用账号立即吊销其全部会话；过期会话在校验路径上即删。

### 4.2 CSRF

- 策略：非 GET 的 `/api/*` 请求若带 `Origin` 头且其 host ≠ 请求 `Host` 头 → 403。配合 `SameSite=Lax` cookie 构成双层防御。
- `Origin: null` 等不可解析值一律拒绝。
- 不带 `Origin` 的请求（同源导航、curl 等非浏览器客户端）放行——它们不携带跨站上下文。
- **部署要求**：反向代理必须透传原始 `Host`（否则合法同源请求会被误判为跨站），见 [SELF-HOST.md](SELF-HOST.md)。

## 5. RBAC 矩阵

角色：`root` / `operator` / `viewer`。归属：站点行有 `operator_id`，operator 只能触达自己名下的站及其派生资源（任务/告警/账本/审计）。

| 资源 / 操作 | root | operator | viewer |
|---|---|---|---|
| 站点：读（列表/详情/渠道/用户/用量/审计） | 全部 | 仅自己 | 全部 |
| 站点：写（开站/升级/启停/销毁/渠道/用户/品牌/域名） | 全部 | 仅自己 | 无 |
| 任务：读 | 全部 | 仅自己站 | 全部 |
| 告警：读 | 全部 | 仅自己站 | 全部 |
| 告警：手动 resolve | 全部 | 仅自己站 | 无 |
| 告警 webhook 设置 | 是 | 无 | 无 |
| 市场模板：读 | 是 | 是 | 是 |
| 市场模板：增删改 | 是 | 无 | 无 |
| 授权（grant/revoke） | 全部站 | 仅自己站 | 无 |
| 账本：读 | 全部 | 仅自己站 | 全部 |
| 账本：手工补账 | 是 | 无 | 无 |
| 套餐：读 | 是 | 是 | 是 |
| 订阅：读自己的 | 是 | 是 | 是 |
| 订阅：开通/取消（全体） | 是 | 无 | 无 |
| 邀请管理 / 操作员管理 | 是 | 无 | 无 |
| 修改自己密码 | 是 | 是 | 是 |
| /metrics | 会话或 Bearer `RP_METRICS_TOKEN` | 同左 | 同左 |

实现要点：`requireWrite`（viewer 403）、`requireRoot`、`canAccessSite`（root/viewer 全站可见、operator 仅 own）；无权查看的站点统一 404"站点不存在"，避免存在性泄露；最后一个 active root 不可被禁用/降级。

## 6. 其他硬化点

- 注册默认关闭；invite 模式的邀请码为一次性、带过期、原子消费（并发重放只成功一次）。
- `/metrics` Bearer 比对为定长（sha256 后）`timingSafeEqual`。
- 引擎调用超时受控（健康探测 8s、渠道测试 30s、Caddy/webhook 5s），单站故障不拖垮面板。
- 引擎数据面隔离：每站独立 compose 项目 + 独立数据库容器，站点可整体导出迁走。
- 编排器默认监听 `127.0.0.1`，公网暴露必须经 HTTPS 反代；Caddy admin API 只监听本机/内网（见 [CADDY.md](CADDY.md)）。

## 7. 漏洞上报（Responsible Disclosure）

请**不要**在公开 issue 中披露安全漏洞。

- 首选：GitHub 仓库的 **Security → Report a vulnerability**（GitHub Security Advisories 私密通道）。
- 请附：影响版本、复现步骤、影响面评估。我们会在修复发布并给用户留出升级窗口后公开致谢。
- 涉及被编排引擎（sub2api / new-api）自身的漏洞，请直接向对应上游项目上报。
