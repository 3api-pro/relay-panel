# deploy/ — 一键部署

```bash
cd deploy
cp .env.example .env      # 按注释填必填项（POSTGRES_PASSWORD / RP_SECRET_KEY / RP_SITES_ROOT / DOCKER_GID）
docker compose up -d --build
```

启动后访问 `http://127.0.0.1:7100`，用 `.env` 里的 `RP_ADMIN_EMAIL` / `RP_ADMIN_PASSWORD` 首次登录。

- 启用 Caddy 反代 + 自动 HTTPS：`docker compose --profile caddy up -d --build`（初始配置见 [docs/CADDY.md](../docs/CADDY.md)）
- 国内网络构建：在 `.env` 设 `NPM_REGISTRY=https://registry.npmmirror.com`
- 铁律：`RP_SITES_ROOT` 在容器内与宿主机路径必须一致（引擎站点的 compose 文件由宿主 docker 解析）
- 容器以非 root 用户运行；访问挂载的 `/var/run/docker.sock` 依赖 `.env` 里 `DOCKER_GID`（宿主 docker 组 gid）

环境变量全表、升级、备份/恢复、从旧版 Basic Auth 迁移等完整文档见 [docs/SELF-HOST.md](../docs/SELF-HOST.md)；日常运维见 [docs/OPERATIONS.md](../docs/OPERATIONS.md)。
