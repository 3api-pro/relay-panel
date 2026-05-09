# 5 分钟自建 Claude API 中转站 (开源 + 一键部署)

> 关键词: Claude API 中转, 开源 AI API 中转, self-host Claude proxy, 一键部署

如果你看过闲鱼上 Claude API 量贩的生意, 一定想过自己开一个站。
但去年那阵 `one-api` / `new-api` 的方案有个共同痛点 — 你必须自己谈
OpenAI / Anthropic 的 API key, 自己充值, 自己处理被封、被限流的问题。

**3API Panel** 解决了这个: 内置上游, 注册即用。你只关心拉客户, 不
碰底层。

## 跟 one-api / new-api 的区别

| | one-api / new-api | 3API Panel |
|---|---|---|
| 上游 API key | 你自己谈 | 内置 (3API 提供) |
| 跨境支付 | 你自己解决 | 我们处理跨境 |
| 号池被封 | 你扛 | 我们扛 |
| 安装复杂度 | 中等 (Docker + 配置) | **5 分钟一键** |
| 多租户托管 | 不支持 | **支持** (TENANT_MODE=multi) |
| License | Apache-2.0 | MIT |

## 安装 (一行命令)

需要一台 Ubuntu 22.04 / Debian 12 / CentOS Stream 9 的 VPS, 1G 内存起步:

```bash
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
```

脚本会自动:
1. 检测系统并装 Docker (如果没装)
2. 拉取 `docker-compose.yml` + `Caddyfile`
3. 提示你输入域名 + 3API wholesale key (`wsk-...`)
4. 生成随机 admin 密码 + JWT secret
5. `docker compose up -d` 起服务

5 分钟后你的 `https://你的域名` 就是一个完整的中转站。

## 商业模式 = multiplexing 套利

我们卖给你 **批发套餐** (跟我们直营同价):
- Pro ¥29/月 一组
- Max5x ¥149/月 一组
- Max20x ¥299/月 一组
- Ultra ¥599/月 一组

一组套餐你可以服务很多客户:
- 5 个轻量客户 (各 ¥10/月) → 你收 ¥50, 成本 ¥29 → 月利 ¥21 (**70%+**)
- 30 个限速客户 (各 ¥15/月) → 你收 ¥450, 成本 ¥299 → 月利 ¥151
- 一组 Ultra 服 50 个混合客户 → 月利 ¥600+

定价灵活: token 计费 / 包月 / 混合, 在你 admin 后台一键切换。

## 多种部署形态

- **自部署** — 你自己 VPS, 自己的域名, 自己的品牌
- **托管 SaaS** — 不想运维? 在 [3api.pro](https://3api.pro) 免费注册
  一个 `<你的名字>.3api.pro` 子域 (或绑定自己的域名), 我们帮你跑

## 为什么开源?

我们做底层 (上游 + 号池 + 协议层); 你做获客 (社区 + SEO + 客服)。
开源让一切透明, 也让你可以自己 fork 改造。我们靠批发量赚, 不靠绑架。

## GitHub

[github.com/3api-pro/relay-panel](https://github.com/3api-pro/relay-panel)

License: MIT。借鉴自 `one-api` (Apache-2.0)。
