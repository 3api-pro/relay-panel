# HackerNews Show HN — submission

**Title** (max 80 chars):
> Show HN: 3API Panel – open-source Claude-compatible API reseller with bundled upstream

**URL**: https://github.com/3api-pro/relay-panel

**Text** (optional but recommended for context):
> Hi HN, I built this after watching the messy Chinese AI API resale market
> for a year. Existing self-host panels like one-api and new-api are great
> but they all assume you BYOK (bring your own keys) — meaning you go
> negotiate with OpenAI/Anthropic, manage credit, deal with bans yourself.
>
> 3API Panel is different: it ships with a bundled upstream (3API
> wholesale) so distributors install it in 5 minutes and immediately have
> a functioning Claude-compatible API to resell. They focus on customer
> acquisition; we handle the upstream relationships.
>
> Same code runs in two modes:
> - Single-tenant: `curl install.sh | bash` on a VPS, your domain
> - Multi-tenant: hosted by us at <name>.3api.pro, free tier
>
> Open source under MIT. Architecture borrows from one-api (quota cents,
> channel pool, redemption codes) plus adds: multi-tenant routing, custom
> domain binding via Caddy on-demand TLS, hybrid token+subscription
> billing, and the bundled upstream itself.
>
> Backend: Express + TypeScript + PostgreSQL. UI: Next.js + Tailwind.
>
> Repo: https://github.com/3api-pro/relay-panel
> Demo will be at https://3api.pro (DNS + deploy in progress)
>
> Feedback welcome — especially on the wholesale economics design and
> the custom-domain CNAME flow.

---

## Reddit r/selfhosted — submission

**Title**:
> 3API Panel: Self-hostable Claude API reseller panel with bundled upstream (open source MIT)

**Text**:
> Hey r/selfhosted, sharing a project I think this community will find
> interesting. Open-source AI API reseller panel, MIT licensed, single
> command to install on any VPS:
>
> ```
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> The novel bit vs one-api/new-api: instead of you bringing your own
> OpenAI/Anthropic keys, the panel ships pointing at a wholesale upstream
> (we operate it, you can also self-supply by changing one env var). For
> people who just want to run a small Claude reseller side-business
> without the operational headache of managing upstream provider
> relationships.
>
> Stack: Node 20 + Express + Postgres + Caddy + Next.js
>
> https://github.com/3api-pro/relay-panel
>
> Looking for early users who want to kick the tires + give feedback.

---

## V2EX — 分享创造

**Title**:
> [开源] 3API Panel — 开源 Claude API 中转分销面板, 内置上游, 一键部署

**Body**:
> 给中文圈做 AI API 中转的同学。
>
> 一年前看到闲鱼上 Claude API 量贩生意, 一直想自己做个 SaaS 工具
> 帮这些小卖家。`one-api` / `new-api` 已经很成熟, 但它们都假设你自
> 己有 OpenAI/Anthropic 的 key — 这个门槛对很多人来说是阻碍。
>
> **3API Panel** 解决这个: 内置上游 (3API wholesale), 装完就能用。
> 分销只关心拉客户, 不碰底层。
>
> 一键安装:
> ```
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> 跟 2API/new-api 比:
> - 不需要自己谈号池, 内置即用
> - 跨境支付/封号风险我们扛
> - 多租户托管模式 (TENANT_MODE=multi)
> - 现代 UI (Next.js + Tailwind 而不是老 Antd)
>
> MIT License。借鉴 one-api 的 quota/channel/redemption 设计。
>
> Repo: https://github.com/3api-pro/relay-panel
> 后续 demo 站会在 https://3api.pro
>
> 找 5-10 个早期分销试用 + 反馈, 留邮箱评论 (不会发, 走 GitHub
> Issues 也行)。

---

## Linux.do — 开发调优 板块

**Title**:
> [开源] 5 分钟搭建自己的 Claude API 中转站 (内置上游)

**Body**:
> 直接放 GitHub: https://github.com/3api-pro/relay-panel
>
> 看了一年闲鱼 Claude API 量贩, 写了个开源面板。跟主流 `one-api` /
> `new-api` 的区别: **内置上游**, 分销不需要自己谈 key。
>
> ## 一键装
> ```
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> ## 经济模型 (multiplexing 套利)
> 我们卖批发套餐 (跟我们直营同价不让利):
> - Pro ¥29 → 你 multiplex 给 5 个轻量客户各 ¥10 → 月利 ¥21 (70%+)
> - Max5x ¥149 → 30 个限速客户各 ¥15 → 月利 ¥151
>
> 终端定价 token / 包月 / 混合任选, admin 后台一键切换。
>
> ## 不一样的地方
> - 多租户托管 (TENANT_MODE=multi) 跑成 SaaS
> - 自定义域绑定, Caddy on-demand TLS
> - 现代栈 Next.js + Tailwind, 不是老 Vue/Antd 风
>
> MIT。希望能找到一些有获客能力的同学一起把这条赛道跑起来。
> Issues / PR 欢迎: https://github.com/3api-pro/relay-panel
