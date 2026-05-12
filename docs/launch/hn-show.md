# Launch templates — v0.8 ready

Polished templates for **HN / r/selfhosted / V2EX / Linux.do**. Drop-in
copy-paste; substitute one URL or screenshot per channel.

> Status at v0.8.0 (2026-05-12): 41 static admin/storefront pages, 55
> OpenAPI endpoints, 1209 zh/en i18n keys at parity, mobile-responsive,
> 9 upstream providers, 14 DB migrations, 24 git commits on `main`.

---

## HackerNews — Show HN

**Title** (max 80 chars):
> Show HN: 3API Panel – Open-source Claude API reseller panel with bundled upstream

**URL**: `https://github.com/3api-pro/relay-panel`

**Text**:
> Hi HN — after a year watching the messy Chinese AI API resale market I
> built a self-hostable panel for it. Existing OSS panels (`one-api`,
> `sub2api`) are mature but assume you already negotiated with
> OpenAI/Anthropic and own a pool of upstream keys. That's the actual
> hard part.
>
> 3API ships with a bundled wholesale upstream (we operate it) so a
> reseller installs in 5 minutes and is selling on day one. BYOK is still
> first-class — mix wholesale and your own keys with weighted failover.
>
> Same code runs in two modes:
> - `docker compose up` on a VPS → your domain, single-tenant
> - Multi-tenant — managed at `<slug>.3api.pro`, free tier
>
> Stack: Node 20 + Express + TypeScript + PostgreSQL + Next.js 14 +
> Tailwind. UI is shadcn/ui + TanStack Table + recharts; zh/en i18n
> with 1200+ keys at parity. MIT license.
>
> What's actually built (v0.8.0):
> - Admin: dashboard with sparklines, plans / orders / users (TanStack
>   Table), upstream channels (9 providers wired), wholesale balance,
>   redemption-code batch generator, per-request usage logs with 4-axis
>   filter, affiliate program (reseller-to-reseller, lifetime commission),
>   webhooks (4 events, HMAC SHA256), light/dark theme, Cmd+K palette,
>   driver.js onboarding tour
> - Storefront: signup / login / password reset / verify email, plan
>   purchase via Alipay + USDT (TRC20/ERC20), API keys, usage stats,
>   subscription billing alongside token packs, daily check-in widget,
>   redeem code page
> - Architecture borrows from `one-api` (channels / quota cents /
>   redemption) plus things they don't have: multi-tenant routing, custom
>   domain binding via Caddy on-demand TLS, hybrid token+sub billing,
>   bundled upstream, iframe-embeddable mini buy-box at /embed/<slug>
>
> Demo: <https://3api.pro> (root domain SaaS) — register and you land on
> your own subdomain admin in 5 seconds.
>
> Feedback most welcome on:
> 1. The wholesale-economics design (multiplexing arbitrage, no markup
>    for distributors)
> 2. The custom-domain CNAME + Caddy on-demand TLS flow
> 3. What's missing for parity with the Chinese-market panels (we have
>    a competitive-research doc at `docs/COMPETITOR-RESEARCH.md`)
>
> Repo: <https://github.com/3api-pro/relay-panel>

---

## Reddit — r/selfhosted

**Title**:
> 3API Panel: self-hostable Claude/OpenAI relay panel with bundled wholesale upstream (MIT)

**Text**:
> Sharing a project I think this community will find interesting: an
> open-source AI API reseller panel for self-hosting on a VPS.
>
> ```bash
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> The novel bit vs `one-api` / `new-api` / `sub2api`: instead of BYOK
> (bring-your-own OpenAI/Anthropic key), the panel ships pre-pointed at a
> wholesale upstream so you start selling without negotiating quota or
> managing key rotations. BYOK is still supported — set `UPSTREAM_KEY` in
> `.env` and you're on your own pool.
>
> Stack: Node 20 + TypeScript + PostgreSQL + Next.js 14 + Tailwind +
> Caddy. Multi-tenant via subdomain or custom domain with Caddy on-demand
> TLS. Single-tenant deploy just sets `TENANT_MODE=single`.
>
> Notable features at v0.8.0:
> - 9 upstream providers (Anthropic / OpenAI / Gemini / DeepSeek /
>   Moonshot / Qwen / MiniMax / llmapi-wholesale / custom)
> - Dual billing: subscription plans + token packs in one UI
> - Daily check-in, redemption codes, affiliate referrals
> - Webhooks (order.paid / subscription.expired / refund.processed /
>   wholesale.low) with HMAC SHA256 signing
> - Admin: logs page, redemption batch generator (1-1000 at a time),
>   light/dark theme, Cmd+K, zh/en i18n
> - Mobile-responsive (iPhone 14 captured + visually verified)
>
> Looking for early users to kick the tires + give feedback. GitHub
> Issues are open; happy to walk anyone through self-host on a fresh VPS.
>
> Repo: <https://github.com/3api-pro/relay-panel>

---

## V2EX — 分享创造

**Title**:
> [开源] 3API Panel — Claude/OpenAI 中转分销面板, 内置上游, 一键自部署

**Body**:
> 给中文圈做 AI API 中转的朋友。
>
> 看了一年闲鱼上 Claude API 量贩生意, 也用过 `one-api` / `new-api` /
> `sub2api`, 写了个开源面板填一块空白:
>
> **3API Panel** 跟主流 OSS 面板的区别 = **内置上游**。
> 装完 5 分钟就能开店, 不用先去谈 OpenAI/Anthropic 的 key。BYOK 仍然
> 支持 — `.env` 改一个 `UPSTREAM_KEY` 就走自己的池。
>
> ## 一键安装
>
> ```bash
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> 或 Hosted SaaS 直接注册: <https://3api.pro/create>, 5 秒钟拿到自己的
> `<slug>.3api.pro` 后台, 可绑自定义域。
>
> ## v0.8.0 现状 (今日发版)
>
> - 9 个上游 (Anthropic / OpenAI / Gemini / DeepSeek / Moonshot / Qwen /
>   MiniMax / llmapi 批发 / custom)
> - 套餐 + token 包**双轨**计费 (one-api 是纯 token 倍率制)
> - 兑换码批量生成 (1-1000 张, 可设前缀 + 过期), 客户面板有兑换入口
> - 每日签到 widget, 站长邀站长 affiliate (10% 终身分成)
> - Webhooks (order.paid / sub.expired / refund / wholesale.low, HMAC SHA256)
> - 调用日志页 + 4 维筛选, 一键 CSV 导出
> - shadcn/ui + TanStack Table + 浅深主题 + Cmd+K + 新手引导
> - 中英双语 1209 keys 100% parity
> - 移动端响应式 (admin drawer + landing hamburger + 紧凑 stepper)
> - 嵌入小组件 `/embed/<slug>` — 博客 iframe 一行带走 3 套餐 + 购买入口
>
> ## 商业模型 (核心差异)
>
> 我们卖批发, 与直营**同价不让利**:
> - Pro ¥29 → multiplex 给 5 个轻量客户各 ¥10 = 月毛 ¥50 → 利 ¥21
> - Max5x ¥149 → 20 个限速客户各 ¥15 = 月毛 ¥300 → 利 ¥151
>
> 终端价站长自定。我们扛号池, 你管获客。
>
> ## 借鉴谁
>
> 数据库设计借了 `one-api` 的 quota_cents + channel pool + redemption,
> UI/UX 借了 `new-api` 的 4-group workspace nav + TanStack Table 风格 +
> `sub2api` 的 multi-key per channel + daily check-in。反学清单见
> `docs/COMPETITOR-RESEARCH.md`。
>
> MIT, 仓库: <https://github.com/3api-pro/relay-panel>。找 5-10 个早期
> 站长一起跑这条赛道, 留邮箱评论或开 GitHub Issue。

---

## Linux.do — 开发调优 板块

**Title**:
> [开源] 5 分钟搭起自己的 Claude API 中转站 (内置上游, 不需要自己谈号池)

**Body**:
> 一年前看闲鱼 Claude 量贩, 一直觉得 `one-api` / `new-api` / `sub2api`
> 这条赛道差了**最痛的一环** — 上游号池。所有 OSS 面板都默认你已经
> 自己有 OpenAI/Anthropic key。
>
> 所以写了个开源面板补上这个: **3API Panel**, 内置 `llmapi.pro` 批发
> 上游, 装完就能卖, 也支持 BYOK。
>
> ## 一键装
>
> ```bash
> curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh | bash
> ```
>
> ## 或者直接用 Hosted SaaS
>
> <https://3api.pro/create> → 邮箱密码 → 5 秒后进自己的 `<slug>.3api.pro/admin`,
> 套餐 + 上游已经 baked, 把链接发出去就开始卖。
>
> ## 跟 new-api / 2API 比少了什么 / 多了什么
>
> 少了:
> - WeChat / Lark OIDC SSO (Overkill, 后续 v1.x 再说)
> - Telegram bot 集成 (同上)
>
> 多了:
> - 内置上游 — 不用自己谈号池, 装完即卖
> - 多租户 (TENANT_MODE=multi 跑成 SaaS, 子域 / 自定义域绑定 Caddy on-demand TLS)
> - 套餐 + token 双轨 (one-api 是纯倍率制, 终端用户体验不好)
> - 现代栈 Next.js 14 + Tailwind + shadcn (不是老 Vue / Antd)
>
> ## 一些数字 (v0.8.0)
>
> - 41 个静态页, 1209 i18n keys 中英 100% parity
> - 9 个 provider 真接入 (Anthropic / OpenAI / Gemini / DeepSeek /
>   Moonshot / Qwen / MiniMax / llmapi-wholesale / custom)
> - 14 个 DB migration, OpenAPI 55 个 endpoint
> - 移动响应式 (iPhone 14 真测), 浅深主题
>
> MIT。这条赛道一个人跑不完, 找 5-10 个有获客的朋友一起。GitHub Issue
> 或私信都行: <https://github.com/3api-pro/relay-panel>
