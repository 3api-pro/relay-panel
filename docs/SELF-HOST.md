# 自部署指南（Self-Host）

从零把 relay-panel 跑到生产：一键 docker compose 部署、全部环境变量、首次登录、反代、升级、备份恢复、旧版迁移。

## 1. 前置要求

- 一台 Linux 服务器（编排的站点容器也跑在这台/这批机器上），安装 Docker Engine + compose 插件。
- 面板对外访问建议配 HTTPS 反代（见 §5）；要用域名自动化再准备 Caddy（见 [CADDY.md](CADDY.md)）。
- 开发机（Windows 亦可，docker 经 WSL）见 §8。

## 2. 一键部署（docker compose）

```bash
git clone https://github.com/3api-pro/relay-panel.git
cd relay-panel/deploy

cp .env.example .env
# 必改三项：
#   RP_SECRET_KEY=$(openssl rand -hex 32)     # 主密钥，生成后离库备份，永不变更除非走轮换流程
#   RP_ADMIN_EMAIL=admin@example.com          # 首登 root 账号
#   RP_ADMIN_PASSWORD=<强密码>

docker compose up -d
```

起来后访问 `http://<服务器IP>:7100`，用 `RP_ADMIN_EMAIL/RP_ADMIN_PASSWORD` 登录。

`deploy/` 目录内容：

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | orchestrator + postgres（编排器状态库）+ 可选 caddy profile |
| `Dockerfile` | 多阶段构建（含 web SPA 构建、运行时带 docker CLI + compose 插件） |
| `.env.example` | 全部 RP_* 变量及中文注释 |

要点：

- orchestrator 容器挂载 `/var/run/docker.sock` 以驱动站点容器——这是部署的信任前提（拿到面板容器等于拿到宿主 docker）。容器内以非 root 用户运行，需把该用户加入 sock 的属组：compose 里用 `group_add: ["<宿主 docker 组 GID>"]`（`getent group docker | cut -d: -f3` 查 GID）。
- 站点数据目录（`RP_SITES_ROOT`）挂持久卷；引擎站点自身的数据在各自 compose 项目的命名卷里。
- 可选 caddy：`docker compose --profile caddy up -d`（域名自动化，配置见 [CADDY.md](CADDY.md)）。

## 3. 环境变量全表

| env | 默认 | 说明 |
|---|---|---|
| `PORT` | 7100 | 监听端口 |
| `RP_HOST` | 127.0.0.1 | 监听地址；**容器部署设 0.0.0.0**（compose 已设） |
| `RP_DB` | `pglite:./data/orchestrator-db` | 编排器状态库：`postgres://user:pass@host:5432/db`、`pglite:<目录>` 或 `pglite:memory`（仅测试）。生产建议 postgres（compose 默认已接） |
| `RP_SECRET_KEY` | 无 | 主密钥：64 位 hex 直接作 32 字节 key，其他值经 sha256 派生。enc: 凭据与面板开站**必需**；缺失时服务可起但相关功能报错 |
| `RP_ADMIN_EMAIL` / `RP_ADMIN_PASSWORD` | 无 | 首启且 operators 表为空时自动创建 root（仅此时生效，之后改这两个值无效果） |
| `RP_SIGNUP_MODE` | closed | `closed` / `invite`（邀请注册）/ `open`（开放注册） |
| `RP_SESSION_TTL_HOURS` | 168 | 会话有效期；剩余不足一半时滑动续期 |
| `RP_SITES_ROOT` | ./data/sites | 站点数据根目录 |
| `RP_PORT_RANGE` | 18100-18999 | 面板开站的宿主端口池（自动分配未占用端口） |
| `RP_DOCKER_VIA_WSL` | 0 | Windows 开发机经 WSL 调 docker 时设 1 |
| `RP_MONITOR_INTERVAL_MS` | 60000 | 告警监控周期；0=关闭 |
| `RP_BALANCE_THRESHOLD` | 0 | >0 时启用 low_balance 告警（best-effort 读渠道余额字段） |
| `RP_METERING_GATEWAY_URL` / `RP_METERING_GATEWAY_TOKEN` | 无 | managed 渠道市场计量网关；未配置时 managed 模板不可启用（[契约](METERING-GATEWAY.md)） |
| `RP_LEDGER_PULL_INTERVAL_MS` | 3600000 | 账本网关拉取周期；0=关闭 |
| `RP_CADDY_ADMIN_URL` | 无 | 如 `http://127.0.0.1:2019`；未配置时域名只记 DB 不下发 |
| `RP_WEB_DIST` | ../web/dist | SPA 构建产物目录（相对 orchestrator 包根；容器镜像内已就位，无需改） |
| `RP_METRICS_TOKEN` | 无 | 设置后 `/metrics` 可用 `Authorization: Bearer` 免 session 抓取 |

空字符串等同未设置（compose 里 `VAR=` 的形态安全）。

## 4. 首次登录与初始化

1. 用 `RP_ADMIN_EMAIL/RP_ADMIN_PASSWORD` 登录 → 设置页**立即改密码**（改密会吊销其他会话）。
2. 邀请团队：`RP_SIGNUP_MODE=invite` 下在"操作员"页生成一次性邀请链接（token 只显示一次）。角色：`root` 管理一切 / `operator` 只见自己站 / `viewer` 全局只读。详见 [SECURITY.md](SECURITY.md) RBAC 矩阵。
3. 开第一个站：站点页 → 新建站点向导（引擎、钉版本、slug、admin 邮箱、品牌），任务时间线里看 provision 步骤。
4. （可选）导入渠道模板、配置告警 webhook、接 Prometheus（[OPERATIONS.md](OPERATIONS.md)）。

另有 CLI 兜底：容器内 `node dist/cli.js create-admin <email>`（密码取 env `RP_NEW_PASSWORD`，缺省生成随机并打印一次）——适用于锁死自己后重建 root。

## 5. 反向代理与 HTTPS

面板自身只讲 HTTP，生产必须置于 HTTPS 反代之后。**关键要求：反代必须透传原始 `Host` 头**——面板的 CSRF 防护校验 `Origin` 与 `Host` 一致，Host 被改写会导致所有写操作 403"跨站请求被拒绝"。

nginx：

```nginx
server {
  listen 443 ssl;
  server_name panel.example.com;
  location / {
    proxy_pass http://127.0.0.1:7100;
    proxy_set_header Host $host;              # 必须：透传原始 Host
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Caddy（Caddyfile，仅代理面板本体，与域名自动化的 JSON 配置是两回事）：

```
panel.example.com {
    reverse_proxy 127.0.0.1:7100
}
```

（Caddy 的 reverse_proxy 默认透传 Host，无需额外配置。）

session cookie 未设 `Secure` 标志（兼容内网 http 场景），因此**不要**同时开放 80 明文入口直达面板——对外只留 443。

## 6. 升级

### 6.1 升级面板

```bash
cd relay-panel && git pull
cd deploy
docker compose build orchestrator
docker compose up -d orchestrator
```

- 数据库迁移在启动时自动执行（幂等、按序、记账于 `schema_migrations`）。
- 升级面板**不影响**在跑的站点容器（数据面独立）。
- 升级前建议先跑一次备份（§7）。回退 = 检出旧版本重新 build + `restore --db`（仅当新版迁移不兼容时才需要恢复 DB）。

### 6.2 升级引擎站点

站点级操作，在面板里做：站点 → 升级 → 填目标版本（钉版本，禁 `latest`）。失败自动回滚旧镜像 tag，数据卷不动。逐站灰度：先升测试站，观察后再批量。

## 7. 备份与恢复

完整流程（含站点级恢复、演练建议）见 [OPERATIONS.md](OPERATIONS.md) §2。最小口径：

```bash
# 备份：编排器 DB + 每站引擎库 dump
node dist/cli.js backup --out /backup/relay-panel
# 恢复编排器（停机状态）
node dist/cli.js restore --db /backup/relay-panel/<ts>/orchestrator.dump
```

`RP_SECRET_KEY` 必须与备份分开另存——两者同失即凭据全丢，两者同在一处即等于明文备份。

## 8. 开发机运行（不走 docker 部署）

```bash
npm install
npm run build            # 或直接 vitest/tsx 开发态
npm run build -w @relay-panel/web
RP_SECRET_KEY=<hex> RP_ADMIN_EMAIL=admin@example.com RP_ADMIN_PASSWORD=<pw> \
  node packages/orchestrator/dist/index.js
```

- 默认 `RP_DB=pglite:./data/orchestrator-db`，零依赖起库。
- Windows 开发机：`RP_DOCKER_VIA_WSL=1`，docker 命令经 WSL 转发。
- 前端联调：`npm run dev -w @relay-panel/web`（vite 代理 `/api` → `http://127.0.0.1:7100`）。

## 9. 从旧版迁移（Basic Auth → session / registry 文件 → DB）

旧版（P1 时代）用 `RP_AUTH_USER/RP_AUTH_PASS` HTTP Basic Auth + `registry.json` 站点注册表。升级到当前版：

1. **认证**：`RP_AUTH_USER/RP_AUTH_PASS` 已移除，设置了也会被忽略。改设 `RP_ADMIN_EMAIL/RP_ADMIN_PASSWORD`——首启 operators 表为空时自动建 root，之后走登录页 cookie session。从 env 里删掉旧的两个变量。
2. **站点注册表**：`registry.json` 不再是运行时事实来源，导入 DB：

   ```bash
   node dist/cli.js import-registry ./registry.json
   ```

   导入语义：站点以 `managed='external'`（接管的存量站，只读生命周期——面板不代为启停/升级）落库，归属第一个 root；凭据引用（`db:` / `devfile:`）原样保留，`credentialDb` 连接参数进 `app_settings`。命令幂等，可重跑。
3. **脚本调用**：原先带 Basic Auth 头的监控脚本改用 `/metrics` + `RP_METRICS_TOKEN`（免 session），或走登录拿 cookie（见 [API.md](API.md) §11）。
4. **验证**：登录 → 站点列表出现存量站且健康探测为绿 → 渠道/用量可读。之后 `registry.json` 仅作纪念，可归档删除。

新开的站一律 `managed='compose'`（面板全生命周期管理）；存量站也可另用 `adopt` 子命令逐个接管：

```bash
node dist/cli.js adopt site-a http://127.0.0.1:18101 --engine sub2api --credential-ref "db:example_db" --label "示例站 A"
```

## 10. 生产检查清单

- [ ] `RP_SECRET_KEY` 已生成（64 hex）且离库备份
- [ ] root 密码已改，`RP_SIGNUP_MODE` 符合预期（默认 closed）
- [ ] 面板只经 HTTPS 反代对外，反代透传 Host
- [ ] `/metrics` 已接 Prometheus，`RP_METRICS_TOKEN` 已设
- [ ] 告警 webhook 已配并演练过一条测试告警
- [ ] 每日备份 cron + 异地同步 + 恢复演练过一次
- [ ] Caddy admin API 未暴露公网（如启用域名自动化）
