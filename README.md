# 3API Panel

> Open-source AI API reseller platform with built-in upstream. One-click VPS install. Multi-tenant SaaS mode.
>
> 开源 AI API 中转 + 二次分销面板, 内置上游, 一键 VPS 部署, 支持托管多租户。

[简体中文](#简体中文) | [English](#english)

---

## English

### What is this?

3API Panel is an open-source self-hostable platform that lets anyone become an AI API reseller in minutes. Unlike `one-api` / `new-api`, it ships with a **built-in upstream** — you don't need to negotiate provider keys yourself. Just install, set your retail price, and start selling.

### Two ways to run

1. **Self-host** (this repo, MIT) — Run on your own VPS. `curl ... | bash` and you're live in 5 minutes.
2. **Hosted SaaS at 3api.pro** — We run it for you. Get a `<your-name>.3api.pro` subdomain, or bring your own custom domain. Free tier available.

### Quick start (self-host)

```bash
curl -sSL https://3api.pro/install | bash
```

Then visit `https://your-vps-ip/admin` to set up your reseller account.

### Architecture (one-line)

`Customer → Your Panel (this repo) → 3API wholesale endpoint → Claude-compatible API`

You bill customers however you want (per-token, monthly subscription, prepaid quota). We bill you wholesale per subscription. Margin is yours.

### License

MIT. Built using ideas from `one-api` (Apache-2.0) and `new-api`.

---

## 简体中文

### 这是什么?

3API Panel 是一个开源的、可自部署的 AI API 中转 + 二次分销平台。让任何人能在几分钟内开自己的"AI API 中转站"。

跟 `one-api` / `new-api` 的区别: **内置上游**, 不需要你自己谈 OpenAI/Anthropic 的 key — 安装即可开卖。

### 两种部署方式

1. **自部署** (本仓, MIT) — 装到自己 VPS, `curl | bash` 5 分钟开站
2. **托管 SaaS @ 3api.pro** — 我们帮你跑, 你拿一个 `<你的名字>.3api.pro` 子域 (或绑定自己的域名), 免费

### 快速开始 (自部署)

```bash
curl -sSL https://3api.pro/install | bash
```

然后访问 `https://你的VPS地址/admin` 配置分销账号。

### 架构 (一句话)

`终端用户 → 你的面板 (本仓) → 3API 上游 → Claude 协议兼容 API`

你按自己想要的方式向终端收费 (按 token / 包月 / 预付额度), 我们按套餐批发收你, 差价是你的利润。

### License

MIT。借鉴自 `one-api` (Apache-2.0) 和 `new-api`。
