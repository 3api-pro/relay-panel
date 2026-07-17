# syntax=docker/dockerfile:1
# relay-panel 编排器一键部署镜像（多阶段构建）。
# 构建（仓库根目录为 context）：
#   docker build -f deploy/Dockerfile .
# 国内网络可换 npm 镜像源：
#   docker build -f deploy/Dockerfile --build-arg NPM_REGISTRY=https://registry.npmmirror.com .

ARG NPM_REGISTRY=https://registry.npmjs.org/

# ---------- 构建阶段：全量依赖 + 编译 TS + 构建前端 SPA ----------
FROM node:22-alpine AS builder
ARG NPM_REGISTRY
WORKDIR /app

# 先只拷贝各包清单，最大化 npm ci 层缓存
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/adapter-core/package.json packages/adapter-core/
COPY packages/adapter-sub2api/package.json packages/adapter-sub2api/
COPY packages/adapter-newapi/package.json packages/adapter-newapi/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/web/package.json packages/web/
RUN npm config set registry "$NPM_REGISTRY" && npm ci

COPY packages ./packages
# workspaces 逐包 build（orchestrator=tsc；web=vite，产物 packages/web/dist）
RUN npm run build
# 只留生产依赖，供运行阶段整体拷贝
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runtime
# docker-cli / docker-cli-compose：经挂载的 /var/run/docker.sock 编排引擎站点容器
# postgresql17-client：backup/restore 子命令要用的 pg_dump / psql
RUN apk add --no-cache docker-cli docker-cli-compose postgresql17-client

ENV NODE_ENV=production
# 容器内监听所有网卡；对外暴露由 compose 端口映射控制
ENV RP_HOST=0.0.0.0

# 非 root 运行。容器要访问挂载的 docker.sock：把宿主 docker 组 gid 授予容器用户，
# 即 compose 里 group_add: ["${DOCKER_GID}"]（gid 查法见 deploy/.env.example）。
RUN addgroup -g 10001 relay && adduser -D -u 10001 -G relay relay

WORKDIR /app
# 整树拷贝（dist + 生产 node_modules + src/db/migrations 等运行时资源）
COPY --from=builder --chown=relay:relay /app/package.json ./package.json
COPY --from=builder --chown=relay:relay /app/node_modules ./node_modules
COPY --from=builder --chown=relay:relay /app/packages ./packages

# 编排器默认数据目录（pglite / 站点目录默认落点；生产建议挂卷，见 compose）
RUN mkdir -p /app/packages/orchestrator/data && chown -R relay:relay /app/packages/orchestrator/data

USER relay
WORKDIR /app/packages/orchestrator

EXPOSE 7100
CMD ["node", "dist/index.js"]
