# 域名自动化：Caddy 对接

relay-panel 用 [Caddy](https://caddyserver.com/) 的 admin API 做"加域名 → 自动 TLS → 生效"的域名自动化：面板里给站点绑定域名后，编排器把一条反代路由写进 Caddy 运行时配置，Caddy 自动签发证书。

- 编排器只需要一个配置：`RP_CADDY_ADMIN_URL`（如 `http://127.0.0.1:2019`）。
- **未配置时**域名功能退化为"只记数据库不下发"——面板仍可维护域名清单，由你自行接到别的反代。

## 1. 初始 Caddy 配置

编排器假设 Caddy 里存在一个名为 **`rp`** 的 HTTP server，站点路由都挂在它下面。给 Caddy 一个如下的初始 JSON 配置（例：`/etc/caddy/caddy.json`）：

```json
{
  "admin": {
    "listen": "127.0.0.1:2019"
  },
  "apps": {
    "http": {
      "servers": {
        "rp": {
          "listen": [":80", ":443"],
          "routes": []
        }
      }
    }
  }
}
```

启动：

```bash
caddy run --config /etc/caddy/caddy.json
```

要点：

- **server 名必须是 `rp`**：编排器写入的路径是 `/config/apps/http/servers/rp/routes`。
- `routes` 留空即可，面板会往里增删。
- 自动 TLS：Caddy 对出现在 host matcher 里的域名默认自动申请/续期证书（HTTP-01/TLS-ALPN），前提是 80/443 从公网可达、域名已解析到本机。无需额外配置。
- **admin API 只监听本机**（`127.0.0.1:2019`），绝不可暴露公网——它等于 Caddy 的 root 权限。编排器与 Caddy 不同机时用内网地址/隧道，并配合防火墙。

如果你已有 Caddyfile 在跑别的业务，可以改用 JSON 整体迁移，或者单独跑一个专供 relay-panel 的 Caddy 实例（admin 端口错开）。

## 2. 编排器写入的路由长什么样

对站点 `site-a`（宿主端口 18101、域名 `api.example.com`），编排器经 admin API 维护这样一条路由对象：

```json
{
  "@id": "rp-site-a",
  "match": [{ "host": ["api.example.com"] }],
  "handle": [
    {
      "handler": "reverse_proxy",
      "upstreams": [{ "dial": "127.0.0.1:18101" }]
    }
  ]
}
```

- 每站一条路由，`@id` 固定为 `rp-<slug>`，站点的全部域名都在同一条 `match.host` 里。
- 幂等下发：先 `DELETE {admin}/id/rp-<slug>`（404 忽略），域名非空时再 `PUT {admin}/config/apps/http/servers/rp/routes` 追加最新版。
- 摘除域名同理；站点域名清空后路由被删除。
- 编排器所有 admin API 调用 5s 超时；下发失败会**回滚数据库中的域名变更**并把错误回给面板。

**不要手工编辑 `rp-` 前缀的路由**——面板下一次下发会覆盖。你自己的路由放在别的 server 或不带 `rp-` 前缀的 `@id` 下即可与面板共存。

## 3. 面板侧用法

1. `.env` 里设置 `RP_CADDY_ADMIN_URL=http://127.0.0.1:2019`，重启编排器。
2. 站点详情 → 域名 tab → 添加域名（或 `POST /api/sites/:slug/domains`，见 [API.md](API.md) §9）。
3. 确认域名 DNS 已指向 Caddy 所在机器；数秒内证书签发完成即可 HTTPS 访问。

## 4. docker compose 里跑 Caddy

`deploy/docker-compose.yml` 带一个可选的 caddy profile（详见 [SELF-HOST.md](SELF-HOST.md)）。要点：

- caddy 容器须映射 80/443，并把上面的初始 JSON 挂进去作为启动配置；
- 证书数据卷（`/data`）必须持久化，否则每次重建都重新签证书（有 CA 速率限制）；
- 编排器容器经 compose 网络访问 `http://caddy:2019`，此时 `RP_CADDY_ADMIN_URL=http://caddy:2019`，且 admin 监听要放在容器网络上（`"listen": ":2019"`，依赖 compose 网络隔离，不映射到宿主机公网）；
- 反代目标写宿主口时注意容器网络可达性：站点容器端口发布在宿主机上时，caddy 容器内 `127.0.0.1` 不是宿主机——用 `host.docker.internal:<hostPort>`（compose 里加 `extra_hosts: ["host.docker.internal:host-gateway"]`）或让 Caddy 直接跑在宿主机上。裸机跑 Caddy（推荐、最简）则无此问题。

## 5. 排查

| 症状 | 排查 |
|---|---|
| 面板加域名报"下发失败" | `curl {RP_CADDY_ADMIN_URL}/config/` 是否通；server 名是否为 `rp` |
| 域名 404 | `curl {admin}/id/rp-<slug>` 看路由是否存在、host 列表是否含该域名 |
| 证书签不下来 | 域名 DNS 是否指到本机；80/443 是否公网可达；看 caddy 日志的 ACME 报错 |
| 路由被"还原" | 是否手工改了 `rp-` 前缀路由——以面板为准，改域名请走面板 |
