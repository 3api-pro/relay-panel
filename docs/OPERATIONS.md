# 运维手册（Operations）

面向生产运行 relay-panel 的操作者：监控与告警语义、备份恢复、审计查询、故障排查。部署与升级见 [SELF-HOST.md](SELF-HOST.md)。

## 1. 监控与告警

### 1.1 告警规则语义

告警引擎按 `RP_MONITOR_INTERVAL_MS`（默认 60s，0=关闭）轮询全部非 destroyed 站点。四种规则：

| kind | severity | 触发 | 恢复 |
|---|---|---|---|
| `site_down` | critical | 引擎健康探测（直接打引擎，不走快照缓存）**连续 3 次**失败 | 探测恢复自动 resolve，并发 resolve 通知 |
| `channel_disabled` | warning | 每 5 轮做一次渠道对比，发现渠道从 enabled 变 disabled（detail 含渠道名）。站点首轮只建基线不告警 | 渠道重新 enabled 自动 resolve |
| `low_balance` | warning | `RP_BALANCE_THRESHOLD > 0` 时，渠道 raw 数据里的数字型 `balance`/`quota` 字段低于阈值。**best-effort**：引擎/上游不提供该字段就跳过 | 手动 resolve |
| `job_failed` | warning | 任意任务（provision/upgrade/start/stop/destroy）终态为 failed，标题"<kind> 任务失败" | **不自动 resolve**，处理后手动关闭 |

- 去重：同 `(kind, siteId)` 只保持一条 open，重复触发只刷新 `last_seen_at`/detail。
- 连续失败计数在内存中——重启面板会重置 `site_down` 的 streak（最坏晚 3 个周期再告警）。

### 1.2 Webhook 通知

- 配置：面板 设置 → 告警 webhook，或 `PUT /api/settings/alerts {"webhookUrl":"https://hook.example.com/alerts"}`（root）。
- 行为：告警 open / resolve 时 POST 一条 JSON（含事件类型、告警、站点概要），5s 超时，失败只记 warn 日志不重试——webhook 是尽力而为的通知面，**告警的事实以面板/DB 为准**。
- 接飞书/钉钉/Slack 等需要特定报文格式时，中间加一层转换服务即可。

### 1.3 Prometheus 抓取

`GET /metrics`（`Authorization: Bearer <RP_METRICS_TOKEN>`）暴露：

```
rp_sites_total{status=…}    按状态站点数
rp_site_up{slug=…}          0|1（来自快照缓存，抓取不触发新探测）
rp_jobs_total{status=…}     按状态任务数
rp_alerts_open{severity=…}  open 告警数
rp_usage24h_cost{slug=…}    各站 24h 成本
```

示例告警规则（prometheus rules）：

```yaml
groups:
  - name: relay-panel
    rules:
      - alert: RelayPanelSiteDown
        expr: rp_site_up == 0
        for: 5m
        labels: { severity: critical }
        annotations: { summary: "站点 {{ $labels.slug }} 不可达" }
      - alert: RelayPanelJobFailed
        expr: increase(rp_jobs_total{status="failed"}[15m]) > 0
        labels: { severity: warning }
      - alert: RelayPanelOpenCritical
        expr: rp_alerts_open{severity="critical"} > 0
        for: 2m
        labels: { severity: critical }
```

面板自身存活另配 `GET /healthz` 黑盒探测。

## 2. 备份与恢复

### 2.1 备份内容

一次完整备份 = **编排器状态** + **每站数据**：

| 内容 | 位置 | 方式 |
|---|---|---|
| 编排器 DB（站点注册、凭据密文、审计、账本、账号） | `RP_DB` | `pg_dump`（pg）或目录拷贝（pglite） |
| 各站引擎数据库 | 每站 compose 内的 postgres 容器 | `docker compose exec -T postgres pg_dump` |
| 主密钥 `RP_SECRET_KEY` | env / 密钥管理 | **单独、离库保存**——没有它凭据密文全部不可解 |

### 2.2 一键备份

```bash
# 生产（已构建）：
node packages/orchestrator/dist/cli.js backup --out /backup/relay-panel
# 开发（源码直跑）：
node --experimental-strip-types packages/orchestrator/src/cli.ts backup --out /backup/relay-panel
```

前置：pg 模式需要 `pg_dump` 在 `PATH` 上（Windows 加 PostgreSQL 安装目录的 `bin`）。

产物按时间戳分目录：

```
/backup/relay-panel/<ts>/
  orchestrator.sql           # 编排器 DB（pg）；pglite 模式则是目录拷贝 orchestrator-db/
  manifest.json              # 清单（不含凭据）
  site-site-a.sql            # 每个 managed compose 站的引擎库 dump
  site-site-b.sql
```

- 输出不含任何明文凭据（编排器 dump 里凭据本来就是密文）。
- 备份结束默认向源库写一条 `backup.run` 审计（尽力而为，失败不影响备份本身）；用只读账号跑或要求对源库零写入时加 `--no-audit`。
- 建议 cron 每日执行 + 异地同步；备份文件与 `RP_SECRET_KEY` 分开存放（同处即等于明文备份）。
- docker 部署时在 orchestrator 容器内执行同命令（compose exec），备份目录挂宿主卷。

### 2.3 恢复：编排器

```bash
# 1. 停面板（docker compose stop orchestrator 或停进程）
# 2. 恢复 DB
node packages/orchestrator/dist/cli.js restore --db /backup/relay-panel/<ts>/orchestrator.sql
#    pg: 经 psql 灌入；pglite: 目录替换（必须停机状态）
# 3. 起面板；确认 RP_SECRET_KEY 与备份时一致，否则 enc: 凭据不可解
```

前置与限制（2026-07 真机演练结论）：

- **恢复引擎必须与备份引擎一致**：`orchestrator.sql`（pg 备份）只能恢复进 pg，pglite 目录备份只能恢复进 pglite；跨引擎迁移暂不支持。
- pg 恢复要求 **目标库已存在且为空**——restore 只做 `psql` 灌入、不建库。应用角色通常无 `CREATEDB`，请由 DBA 预建空库（或临时授予权限）。
- pg 模式需要 `psql` 在 `PATH` 上。
- 恢复成功后会向**恢复后的库**补一条 `db.restore` 审计（尽力而为）；与备份时点做逐表对账时注意扣除这一行。

### 2.4 恢复：单站数据（站点级）

场景：某站数据损坏 / 误操作，编排器本身完好。

```bash
# 1. 面板里停掉该站（或 POST /api/sites/site-a/stop），等任务完成
# 2. 只起该站的 postgres 服务，灌入备份
docker compose -p <compose_project> up -d postgres
docker compose -p <compose_project> exec -T postgres \
  psql -U <engine_db_user> -d <engine_db> < /backup/relay-panel/<ts>/site-site-a.sql
# 3. 面板里启动该站，观察健康探测转绿
```

compose 项目名与库名/用户可在面板站点详情（或编排器 DB `sites` 行）查到；引擎 DB 口令在该站 compose env 内，不需要人工经手明文。

场景：整机迁移/重建——先恢复编排器（2.3），再对每个站重跑上面的站点级恢复；站点容器由面板重新 provision（数据卷灌回后升级到原版本号）。

### 2.5 恢复演练

**没有演练过的备份等于没有备份。**建议每季度：挑一个测试站，在隔离环境按 2.3 + 2.4 全流程走一遍，校验面板登录、站点健康、账本完整。

## 3. 审计查询

所有写操作都在 `audit_events` 表（payload 已脱敏）。动作名规则 `<域>.<动作>`：`auth.login` / `auth.signup` / `invite.create` / `operator.update` / `site.provision` / `channel.create` / `marketplace.grant` / `billing.subscribe` / `domain.add` / `alert.resolve` 等。

常用 SQL（psql 连编排器库；pglite 可用 CLI/面板审计页）：

```sql
-- 最近 24h 全部失败操作
SELECT created_at, actor, action, error
FROM audit_events
WHERE ok = false AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;

-- 某操作员的全部写操作
SELECT created_at, action, site_id, ok
FROM audit_events
WHERE actor = 'op@example.com'
ORDER BY created_at DESC LIMIT 100;

-- 某站的全部变更（含渠道/用户/品牌/域名）
SELECT a.created_at, a.actor, a.action, a.ok, a.error
FROM audit_events a JOIN sites s ON s.id = a.site_id
WHERE s.slug = 'site-a'
ORDER BY a.created_at DESC LIMIT 100;

-- 登录失败聚类（爆破排查）
SELECT actor, count(*) AS fails, max(created_at) AS last_at
FROM audit_events
WHERE action = 'auth.login' AND ok = false AND created_at > now() - interval '7 days'
GROUP BY actor ORDER BY fails DESC;

-- 渠道相关变更审计
SELECT created_at, actor, action, payload
FROM audit_events
WHERE action LIKE 'channel.%' OR action LIKE 'marketplace.%'
ORDER BY created_at DESC LIMIT 50;
```

面板内：站点详情 → 审计 tab（`GET /api/sites/:slug/audit`）。

## 4. 故障排查

### 4.1 站点健康探测失败（site_down / 卡片红）

按层排：

1. **容器**：`docker compose -p <compose_project> ps`——引擎与其 postgres 是否都 Up。
2. **端口**：宿主机 `curl -sS http://127.0.0.1:<hostPort>/<引擎健康路径>`（sub2api `/health`，new-api `/api/status`）。通 → 面板与站点间网络问题；不通 → 看容器日志。
3. **引擎日志**：`docker compose -p <compose_project> logs --tail 200 <engine服务>`——常见：DB 未就绪、迁移失败、磁盘满。
4. **面板侧**：探测超时 8s，站点负载尖峰会引发闪断误报（连续 3 次才告警已滤掉大部分抖动）。持续 flapping 考虑站点扩资源。

健康恢复但站点功能异常（能 ping 通、admin 调用失败）→ 走 4.3 凭据排查。

### 4.2 任务卡住（一直 queued / running）

- **queued 不动**：全局并发 2、同 slug 串行——先看是否有别的任务占位（`GET /api/jobs?slug=…`）。job worker 随面板进程启动，确认面板日志无启动报错。
- **running 很久**：看任务 steps 时间线卡在哪步（面板任务详情 / `GET /api/jobs/:id`）。compose 拉镜像慢是最常见原因（首次 provision/upgrade 需拉引擎镜像）。
- **面板重启后遗留 running**：进程中断时正在跑的任务不会自动续跑。处置：确认宿主机上该站容器实际状态（`docker compose ps`），必要时手动把站点拉回一致状态（stop/start 任务），失败任务重新发起。provision 幂等，重跑会从断点续。
- **同 slug 409**：等在跑的任务终态，或确认其已死后（见上）再重试。

### 4.3 凭据问题与轮换

症状：站点健康但渠道/用户/品牌读取报错、开站后 admin 调用 401。

- **RP_SECRET_KEY 是否变过**：解密报错（`secret decryption failed`）几乎必是主密钥换了。恢复原 key，或按下述轮换流程重建凭据。
- **引擎侧凭据被改**：有人在引擎后台改了 admin 密码/重置了 admin key，编排器存的旧凭据失效。用引擎新凭据重建 `credentials` 行（重新加密入库），或对可重入的站重跑 admin 初始化。
- **主密钥轮换流程**：目前无一键命令，流程为——停面板 → 用旧 key 解密全部 `credentials` 行、用新 key 重加密写回（写一次性脚本，明文只在内存）→ 更新 env → 起面板。轮换期间面板不可用；脚本不得把明文写入任何文件/日志。
- **单站凭据轮换**：在引擎后台生成新的长期 admin key → 更新该站 `credentials` 行密文 → 面板上验证渠道列表可读 → 吊销旧 key。顺序保证零窗口。

### 4.4 渠道市场 / 账本

- managed 授权报"计量网关未配置"：`RP_METERING_GATEWAY_URL/TOKEN` 未设置（见 [METERING-GATEWAY.md](METERING-GATEWAY.md)）。
- 账本没新数据：拉取循环周期 `RP_LEDGER_PULL_INTERVAL_MS`（默认 1h，0=关闭）；网关只回已封口的时间桶，当天桶要等封口后才入账；看面板日志里的拉取报错。
- 撤销授权时站点不可达：`DELETE /api/marketplace/grants/:id?force=1` 仅改状态（站恢复后需人工确认引擎里渠道已删）。

### 4.5 域名

见 [CADDY.md](CADDY.md) §5。

### 4.6 面板起不来 / 起来但功能报错

- 启动即退：看日志第一行报错——`环境变量配置无效`（对照 [SELF-HOST.md](SELF-HOST.md) env 表）、DB 连不上、迁移失败。
- 起来但开站报错：`RP_SECRET_KEY` 未设置（开站必需）；docker 不可用（sock 未挂载/权限）。
- 页面 "web 未构建"：`npm run build -w @relay-panel/web` 后刷新（API 不受影响）。
