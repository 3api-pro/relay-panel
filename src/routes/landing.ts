/**
 * Marketing landing page served at GET / when the request lands on the
 * SaaS root domain (e.g. 3api.pro / www.3api.pro). Subdomains route to
 * tenant pages via tenantResolver elsewhere.
 *
 * Self-contained HTML — no asset pipeline. Bilingual (zh + en) and
 * dark-mode aware via the inline boot script + data-i18n attributes.
 * Replace with a real frontend build when the marketing site grows past
 * one page.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';

export const landingRouter = Router();

const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title data-i18n="meta.title">3API Panel — 30 分钟开起你自己的 Claude 中转店, 零库存一键部署</title>
<meta name="description" data-i18n-attr="content" data-i18n="meta.description" content="不用谈号池, 不用自己买 API key — 3api 内置 llmapi.pro 批发上游, 一键部署 / 一键接入 / 一键支付, 30 分钟开起自己的 Claude 中转分销店。MIT 开源。">
<script>
// Bootstrap theme + lang BEFORE first paint so we avoid the FOUC of
// flashing light/zh to a user who prefers dark/en.
(function(){
  try {
    var t = localStorage.getItem('3api_theme');
    if (t !== 'light' && t !== 'dark') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.classList.remove('light','dark');
    document.documentElement.classList.add(t);
    document.documentElement.setAttribute('data-theme', t);

    var l = localStorage.getItem('3api_locale');
    if (l !== 'zh' && l !== 'en') {
      try {
        var ck = document.cookie.split('; ').find(function(c){return c.indexOf('3api_locale=')===0;});
        if (ck) l = decodeURIComponent(ck.substring('3api_locale='.length));
      } catch(_){}
    }
    if (l !== 'zh' && l !== 'en') {
      var nav = (navigator.language || '').toLowerCase();
      l = nav.indexOf('en') === 0 ? 'en' : 'zh';
    }
    document.documentElement.setAttribute('data-lang', l);
    document.documentElement.lang = (l === 'en') ? 'en' : 'zh-CN';
  } catch(_) {}
})();
</script>
<style>
  :root, html.light {
    --ink: #0f172a; --mute: #475569; --line: #e2e8f0; --accent: #0d9488; --accent2: #0f766e;
    --bg: #f8fafc; --bg-elev: #f1f5f9; --surface: #ffffff; --surface-2: #ffffff;
    --pre-bg: #0f172a; --pre-fg: #e2e8f0; --pre-comment: #64748b;
    --btn-ghost-bg: #ffffff; --shadow-soft: 0 6px 12px -8px rgba(15,23,42,0.18);
  }
  html.dark {
    --ink: #e2e8f0; --mute: #94a3b8; --line: #1f2937; --accent: #14b8a6; --accent2: #2dd4bf;
    --bg: #0b1220; --bg-elev: #111a2e; --surface: #111a2e; --surface-2: #0f1729;
    --pre-bg: #050a14; --pre-fg: #e2e8f0; --pre-comment: #64748b;
    --btn-ghost-bg: #111a2e; --shadow-soft: 0 6px 16px -8px rgba(0,0,0,0.55);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; transition: background-color .18s ease, color .18s ease; }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  header { background: var(--surface); border-bottom: 1px solid var(--line); }
  header .row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; position: relative; gap: 12px; }
  header .brand { font-weight: 600; font-size: 18px; letter-spacing: -0.01em; }
  header .brand .dot { display: inline-block; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  header nav { display: flex; align-items: center; }
  header nav a { margin-left: 18px; font-size: 14px; color: var(--mute); }
  header nav a:hover { color: var(--ink); }
  header nav .cta { background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 6px; }
  header nav .cta:hover { background: var(--accent2); color: #fff; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 8px; color: var(--mute); cursor: pointer; background: transparent; border: 1px solid transparent; margin-left: 6px; }
  .icon-btn:hover { color: var(--ink); background: var(--bg-elev); border-color: var(--line); }
  .icon-btn svg { width: 18px; height: 18px; }
  html.light .icon-btn .i-moon, html.dark .icon-btn .i-sun { display: inline-block; }
  html.light .icon-btn .i-sun, html.dark .icon-btn .i-moon { display: none; }
  .nav-toggle { display: none; }
  .nav-burger { display: none; flex-direction: column; gap: 4px; cursor: pointer; padding: 8px; margin: -8px; border-radius: 6px; }
  .nav-burger:hover { background: var(--bg-elev); }
  .nav-burger span { width: 22px; height: 2px; background: var(--ink); border-radius: 1px; transition: transform .15s, opacity .15s; }
  @media (max-width: 720px) {
    .nav-burger { display: flex; order: 3; }
    header .row { flex-wrap: wrap; }
    header nav { display: none; position: absolute; top: 56px; right: 0; left: 0; flex-direction: column; padding: 8px 24px 16px; background: var(--surface); border-bottom: 1px solid var(--line); box-shadow: var(--shadow-soft); z-index: 20; align-items: stretch; }
    header nav a { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 15px; }
    header nav a:last-child { border-bottom: 0; }
    header nav .cta { display: inline-block; align-self: flex-start; margin-top: 8px; padding: 10px 18px; }
    header nav .icon-btn { margin: 8px 8px 0 0; align-self: flex-start; }
    .nav-toggle:checked ~ nav { display: flex; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
    .nav-toggle:checked ~ .nav-burger span:nth-child(2) { opacity: 0; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
  }

  .hero { padding: 80px 0 60px; text-align: center; }
  .hero h1 { font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin: 0 auto; max-width: 800px; line-height: 1.15; }
  .hero p { color: var(--mute); font-size: 18px; max-width: 640px; margin: 24px auto 0; line-height: 1.6; }
  .hero p strong { color: var(--accent2); }
  @media (max-width: 720px) {
    .hero { padding: 48px 0 40px; }
    .hero h1 { font-size: 30px; line-height: 1.2; }
    .hero p { font-size: 15px; margin-top: 18px; padding: 0 4px; }
    .hero .ctas { margin-top: 24px; }
    .btn { padding: 11px 18px; font-size: 14px; }
  }
  .hero .ctas { margin-top: 36px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn { padding: 12px 22px; border-radius: 8px; font-size: 15px; font-weight: 500; }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent2); }
  .btn.ghost { border: 1px solid var(--line); background: var(--btn-ghost-bg); color: var(--ink); }
  .btn.ghost:hover { border-color: var(--accent); }

  .install { margin: 28px auto 0; max-width: 720px; }
  pre { background: var(--pre-bg); color: var(--pre-fg); padding: 14px 18px; border-radius: 8px; font-size: 13px; line-height: 1.6; text-align: left; overflow-x: auto; margin: 0; }
  pre .c { color: var(--pre-comment); }

  .features { padding: 60px 0; background: var(--surface); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .features h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .features .sub { text-align: center; color: var(--mute); margin-bottom: 40px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--bg-elev); border: 1px solid var(--line); border-radius: 10px; padding: 22px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; }
  .card p { margin: 0; color: var(--mute); font-size: 14px; line-height: 1.6; }
  .card code { background: var(--bg); padding: 2px 6px; border-radius: 4px; font-size: 13px; color: var(--ink); }

  .compare { padding: 60px 0; }
  .compare h2 { text-align: center; font-size: 28px; margin: 0 0 24px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--line); font-size: 14px; }
  th { background: var(--bg-elev); font-weight: 600; color: var(--mute); }
  tr:last-child td { border-bottom: 0; }
  td.y { color: var(--accent2); font-weight: 600; }
  td.n { color: var(--mute); }

  .badges { padding: 28px 0 8px; }
  .badges .grid { gap: 18px; }
  .badge { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px; text-align: center; transition: border-color .15s, transform .15s; }
  .badge:hover { border-color: var(--accent); transform: translateY(-2px); }
  .badge .icon { display: inline-flex; align-items: center; justify-content: center; height: 40px; width: 40px; color: var(--accent); margin-bottom: 12px; }
  .badge h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); }
  .badge .sub { color: var(--mute); font-size: 13px; line-height: 1.5; }
  .badge .sub strong { color: var(--accent2); }

  .why { padding: 60px 0; }
  .why h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .why .sub-h { text-align: center; color: var(--mute); margin-bottom: 40px; }
  .why .card { background: var(--surface); }
  .why .card .kicker { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; color: var(--accent2); text-transform: uppercase; margin-bottom: 8px; }
  .why .card h3 { font-size: 18px; margin: 0 0 8px; }

  .testimonials { padding: 60px 0; background: var(--surface); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .testimonials h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .testimonials .sub-h { text-align: center; color: var(--mute); margin-bottom: 40px; font-size: 13px; }
  .quote { background: var(--bg-elev); border: 1px solid var(--line); border-radius: 10px; padding: 22px; }
  .quote p { margin: 0 0 12px; color: var(--ink); font-size: 15px; line-height: 1.55; }
  .quote .who { color: var(--mute); font-size: 13px; }

  .cta-final { padding: 80px 0; text-align: center; }
  .cta-final h2 { font-size: 32px; margin: 0 0 14px; letter-spacing: -0.01em; }
  .cta-final p { color: var(--mute); margin: 0 0 28px; }

  footer { padding: 32px 0; color: var(--mute); font-size: 13px; text-align: center; }
  footer a { color: var(--accent2); }
  footer a:hover { text-decoration: underline; }
  footer .legal { margin-top: 10px; font-size: 12px; color: var(--mute); opacity: 0.75; }
</style>
</head>
<body>

<header>
  <div class="wrap row">
    <div class="brand"><span class="dot"></span>3API Panel</div>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
    <label for="nav-toggle" class="nav-burger" role="button" data-i18n-attr="aria-label" data-i18n="nav.menu" aria-label="菜单" aria-controls="primary-nav">
      <span></span><span></span><span></span>
    </label>
    <nav id="primary-nav">
      <a href="https://github.com/3api-pro/relay-panel">GitHub</a>
      <a href="/pricing" data-i18n="nav.demo">看演示</a>
      <a href="https://github.com/3api-pro/relay-panel#readme" data-i18n="nav.docs">Docs</a>
      <a href="/admin/login/" data-i18n="nav.login">登录</a>
      <a href="/create/" class="cta" data-i18n="nav.cta">开始 →</a>
      <button class="icon-btn" id="lang-toggle" type="button" data-i18n-attr="aria-label" data-i18n="nav.lang_label" aria-label="切换语言" title="EN / 中文">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14M7 12c0-3 2-6 5-6s5 3 5 6-2 6-5 6"/><path d="M9 18c1.5-3 3-6 3-12"/><path d="M15 18c-1.5-3-3-6-3-12"/></svg>
      </button>
      <button class="icon-btn" id="theme-toggle" type="button" data-i18n-attr="aria-label" data-i18n="nav.theme_label" aria-label="切换主题" title="Light / Dark">
        <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <h1 data-i18n="hero.title">30 分钟, 开起你自己的 Claude 中转店</h1>
    <p data-i18n="hero.body" data-i18n-html="1">
      不用谈号池, 不用自己买 API key — 3api 内置 <strong>llmapi.pro 批发上游</strong>, 开箱即用。
      其他开源中转面板要你自己拼号池, 这里注册就能卖。
    </p>
    <div class="ctas">
      <a href="/create/" class="btn primary" data-i18n="hero.cta_primary">免费注册, 立即开店 →</a>
      <a href="https://github.com/3api-pro/relay-panel" class="btn ghost" data-i18n="hero.cta_secondary">我有 key, 想 BYOK 自部署</a>
    </div>
  </div>
</section>

<section class="badges">
  <div class="wrap">
    <div class="grid">
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg></div>
        <h3 data-i18n="badge1.title">一键部署</h3>
        <div class="sub" data-i18n="badge1.sub" data-i18n-html="1"><strong>docker compose up</strong><br>10 秒起站, 也可托管 SaaS 注册即用</div>
      </div>
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg></div>
        <h3 data-i18n="badge2.title">一键接入</h3>
        <div class="sub" data-i18n="badge2.sub" data-i18n-html="1"><strong>内置 llmapi 批发上游</strong><br>零库存 — 注册当天就能接客</div>
      </div>
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></div>
        <h3 data-i18n="badge3.title">一键支付</h3>
        <div class="sub" data-i18n="badge3.sub" data-i18n-html="1"><strong>Alipay / USDT 配好即收款</strong><br>账款直接入站长账户, 平台不过手</div>
      </div>
    </div>
  </div>
</section>

<section class="why">
  <div class="wrap">
    <h2 data-i18n="why.title">为什么选 3api</h2>
    <div class="sub-h" data-i18n="why.subtitle">和自部署 new-api / sub2api 比, 你省下的事</div>
    <div class="grid">
      <div class="card">
        <div class="kicker" data-i18n="why.card1.kicker">零库存</div>
        <h3 data-i18n="why.card1.title">不用谈号池</h3>
        <p data-i18n="why.card1.body">其他中转面板要你自己谈 Anthropic Console / OpenAI org key, 拿到要几天到几周。3api 一键接入 llmapi.pro 批发, ¥10 起充就有 Claude 兼容 API 可卖。</p>
      </div>
      <div class="card">
        <div class="kicker" data-i18n="why.card2.kicker">平台兜底</div>
        <h3 data-i18n="why.card2.title">上游挂了我们换</h3>
        <p data-i18n="why.card2.body">llmapi.pro 维护多 base 上游池 (Anthropic 官方 / Claude Code 兼容多通道), 单通道挂掉自动 failover。你只管卖, 不用半夜起来切 base。</p>
      </div>
      <div class="card">
        <div class="kicker" data-i18n="why.card3.kicker">30 分钟开店</div>
        <h3 data-i18n="why.card3.title">注册 → 接客</h3>
        <p data-i18n="why.card3.body" data-i18n-html="1">注册 → 选套餐 → 配 Alipay / USDT → 把 <code>&lt;slug&gt;.3api.pro</code> 发给客户。子域和 TLS 都给你配好, 不用自己玩 Caddy。</p>
      </div>
    </div>
  </div>
</section>

<section class="testimonials">
  <div class="wrap">
    <h2 data-i18n="quotes.title">站长说</h2>
    <div class="sub-h" data-i18n="quotes.subtitle">下面是早期内测站长的反馈, v0.4 会放真实 case study (含数据截图)</div>
    <div class="grid">
      <div class="quote">
        <p data-i18n="quotes.q1.body">"上线两周接了 50 个客户。最爽的是不用自己折腾 Anthropic Console — 充值到批发账户, 我只管定零售价。"</p>
        <div class="who" data-i18n="quotes.q1.who">— 独立开发者, 留学生群转售</div>
      </div>
      <div class="quote">
        <p data-i18n="quotes.q2.body">"月入 5K, 不用谈号池。Anthropic 那边的封号风险跟我没关系, 上游挂了平台帮我换通道。"</p>
        <div class="who" data-i18n="quotes.q2.who">— 自由职业者, 个人订阅站点</div>
      </div>
      <div class="quote">
        <p data-i18n="quotes.q3.body">"客户买套餐我躺赚。订阅 + Token 双轨, 后台自动出账, 我每月看一次结算。"</p>
        <div class="who" data-i18n="quotes.q3.who">— 小工作室, Cursor 用户社区</div>
      </div>
    </div>
  </div>
</section>

<section class="features">
  <div class="wrap">
    <h2 data-i18n="self.title">开发者也可以自部署</h2>
    <div class="sub" data-i18n="self.subtitle" data-i18n-html="1">不喜欢 SaaS? clone 仓库, MIT 开源, Docker Compose 起服务。<br>支持 Linux / macOS, 以及 Windows (Docker Desktop)。</div>
    <div class="install" id="install" style="margin-bottom:32px">
      <pre data-i18n="self.install_block" data-i18n-html="1"><span class="c"># 任意装了 Docker 的机器都可以跑</span>
git clone https://github.com/3api-pro/relay-panel
cd relay-panel
cp .env.example .env   <span class="c"># 改 POSTGRES_PASSWORD / JWT_SECRET / UPSTREAM_KEY</span>
docker compose up -d
<span class="c"># → http://localhost:8080 → 注册 → 引导向导 → 完成</span></pre>
    </div>
    <div class="grid">
      <div class="card">
        <h3 data-i18n="self.card1.title">内置批发上游</h3>
        <p data-i18n="self.card1.body">不需要自己买 OpenAI / Anthropic key, 装完就有 Claude 兼容 API 可卖。也支持自带上游, 一个 env 变量切换。</p>
      </div>
      <div class="card">
        <h3 data-i18n="self.card2.title">多租户托管模式</h3>
        <p data-i18n="self.card2.body">同一份代码两种部署: 单租户自部署 (你的域名), 或多租户跑 SaaS (子域 + 自定义域绑定 + Caddy on-demand TLS)。</p>
      </div>
      <div class="card">
        <h3 data-i18n="self.card3.title">现代栈</h3>
        <p data-i18n="self.card3.body">Express + TypeScript + Postgres + Caddy + Next.js 14。SSE 流式中转、token 桶限流、原子额度扣费、幂等购买。</p>
      </div>
    </div>
  </div>
</section>

<section class="compare">
  <div class="wrap">
    <h2 data-i18n="compare.title">选择你的部署方式</h2>
    <table>
      <tr>
        <th data-i18n="compare.col_cap">能力</th>
        <th data-i18n="compare.col_oss">自部署 (OSS)</th>
        <th data-i18n="compare.col_hosted">3api.pro 托管</th>
      </tr>
      <tr>
        <td data-i18n="compare.row1.label">价格</td>
        <td class="y" data-i18n="compare.row1.oss">免费</td>
        <td class="y" data-i18n="compare.row1.hosted">免运维</td>
      </tr>
      <tr>
        <td data-i18n="compare.row2.label">需要自己运维 / DB</td>
        <td data-i18n="compare.row2.oss">是</td>
        <td data-i18n="compare.row2.hosted">否</td>
      </tr>
      <tr>
        <td data-i18n="compare.row3.label">自带上游 (BYOK)</td>
        <td class="y" data-i18n="compare.row3.oss">支持</td>
        <td class="y" data-i18n="compare.row3.hosted">支持</td>
      </tr>
      <tr>
        <td data-i18n="compare.row4.label">跨境支付 / 封号风险</td>
        <td data-i18n="compare.row4.oss">你扛</td>
        <td class="y" data-i18n="compare.row4.hosted">我们扛</td>
      </tr>
      <tr>
        <td data-i18n="compare.row5.label">子域 / 自定义域绑定</td>
        <td data-i18n="compare.row5.oss">自己配 Caddy</td>
        <td class="y" data-i18n="compare.row5.hosted">已配好</td>
      </tr>
    </table>
  </div>
</section>

<section class="cta-final">
  <div class="wrap">
    <h2 data-i18n="final.title">30 分钟后, 你也能有一个收款的中转店</h2>
    <p data-i18n="final.body">注册免费, 不用绑信用卡, 不用谈号池。先开起来再说。</p>
    <div class="ctas">
      <a href="/create/" class="btn primary" data-i18n="final.cta_primary">立即注册, 开店 →</a>
      <a href="/pricing" class="btn ghost" data-i18n="final.cta_secondary">先看看套餐定价</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <span data-i18n="footer.license">Open source under MIT</span> · <a href="https://github.com/3api-pro/relay-panel">github.com/3api-pro/relay-panel</a>
    <div class="legal" data-i18n="footer.legal" data-i18n-html="1">
      Independent project. Not affiliated with Anthropic / OpenAI. Default upstream <code>api.llmapi.pro</code> is operated by an independent provider; swappable.
    </div>
  </div>
</footer>

<script>
// Inline i18n + theme controller. Keeps the page self-contained.
(function(){
  var STRINGS = {
    zh: {
      "meta.title": "3API Panel — 30 分钟开起你自己的 Claude 中转店, 零库存一键部署",
      "meta.description": "不用谈号池, 不用自己买 API key — 3api 内置 llmapi.pro 批发上游, 一键部署 / 一键接入 / 一键支付, 30 分钟开起自己的 Claude 中转分销店。MIT 开源。",
      "nav.menu": "菜单",
      "nav.demo": "看演示",
      "nav.docs": "Docs",
      "nav.login": "登录",
      "nav.cta": "开始 →",
      "nav.lang_label": "切换语言",
      "nav.theme_label": "切换主题",
      "hero.title": "30 分钟, 开起你自己的 Claude 中转店",
      "hero.body": "不用谈号池, 不用自己买 API key — 3api 内置 <strong>llmapi.pro 批发上游</strong>, 开箱即用。其他开源中转面板要你自己拼号池, 这里注册就能卖。",
      "hero.cta_primary": "免费注册, 立即开店 →",
      "hero.cta_secondary": "我有 key, 想 BYOK 自部署",
      "badge1.title": "一键部署",
      "badge1.sub": "<strong>docker compose up</strong><br>10 秒起站, 也可托管 SaaS 注册即用",
      "badge2.title": "一键接入",
      "badge2.sub": "<strong>内置 llmapi 批发上游</strong><br>零库存 — 注册当天就能接客",
      "badge3.title": "一键支付",
      "badge3.sub": "<strong>Alipay / USDT 配好即收款</strong><br>账款直接入站长账户, 平台不过手",
      "why.title": "为什么选 3api",
      "why.subtitle": "和自部署 new-api / sub2api 比, 你省下的事",
      "why.card1.kicker": "零库存",
      "why.card1.title": "不用谈号池",
      "why.card1.body": "其他中转面板要你自己谈 Anthropic Console / OpenAI org key, 拿到要几天到几周。3api 一键接入 llmapi.pro 批发, ¥10 起充就有 Claude 兼容 API 可卖。",
      "why.card2.kicker": "平台兜底",
      "why.card2.title": "上游挂了我们换",
      "why.card2.body": "llmapi.pro 维护多 base 上游池 (Anthropic 官方 / Claude Code 兼容多通道), 单通道挂掉自动 failover。你只管卖, 不用半夜起来切 base。",
      "why.card3.kicker": "30 分钟开店",
      "why.card3.title": "注册 → 接客",
      "why.card3.body": "注册 → 选套餐 → 配 Alipay / USDT → 把 <code>&lt;slug&gt;.3api.pro</code> 发给客户。子域和 TLS 都给你配好, 不用自己玩 Caddy。",
      "quotes.title": "站长说",
      "quotes.subtitle": "下面是早期内测站长的反馈, v0.4 会放真实 case study (含数据截图)",
      "quotes.q1.body": "\\"上线两周接了 50 个客户。最爽的是不用自己折腾 Anthropic Console — 充值到批发账户, 我只管定零售价。\\"",
      "quotes.q1.who": "— 独立开发者, 留学生群转售",
      "quotes.q2.body": "\\"月入 5K, 不用谈号池。Anthropic 那边的封号风险跟我没关系, 上游挂了平台帮我换通道。\\"",
      "quotes.q2.who": "— 自由职业者, 个人订阅站点",
      "quotes.q3.body": "\\"客户买套餐我躺赚。订阅 + Token 双轨, 后台自动出账, 我每月看一次结算。\\"",
      "quotes.q3.who": "— 小工作室, Cursor 用户社区",
      "self.title": "开发者也可以自部署",
      "self.subtitle": "不喜欢 SaaS? clone 仓库, MIT 开源, Docker Compose 起服务。<br>支持 Linux / macOS, 以及 Windows (Docker Desktop)。",
      "self.install_block": "<span class=\\"c\\"># 任意装了 Docker 的机器都可以跑</span>\\ngit clone https://github.com/3api-pro/relay-panel\\ncd relay-panel\\ncp .env.example .env   <span class=\\"c\\"># 改 POSTGRES_PASSWORD / JWT_SECRET / UPSTREAM_KEY</span>\\ndocker compose up -d\\n<span class=\\"c\\"># → http://localhost:8080 → 注册 → 引导向导 → 完成</span>",
      "self.card1.title": "内置批发上游",
      "self.card1.body": "不需要自己买 OpenAI / Anthropic key, 装完就有 Claude 兼容 API 可卖。也支持自带上游, 一个 env 变量切换。",
      "self.card2.title": "多租户托管模式",
      "self.card2.body": "同一份代码两种部署: 单租户自部署 (你的域名), 或多租户跑 SaaS (子域 + 自定义域绑定 + Caddy on-demand TLS)。",
      "self.card3.title": "现代栈",
      "self.card3.body": "Express + TypeScript + Postgres + Caddy + Next.js 14。SSE 流式中转、token 桶限流、原子额度扣费、幂等购买。",
      "compare.title": "选择你的部署方式",
      "compare.col_cap": "能力",
      "compare.col_oss": "自部署 (OSS)",
      "compare.col_hosted": "3api.pro 托管",
      "compare.row1.label": "价格",
      "compare.row1.oss": "免费",
      "compare.row1.hosted": "免运维",
      "compare.row2.label": "需要自己运维 / DB",
      "compare.row2.oss": "是",
      "compare.row2.hosted": "否",
      "compare.row3.label": "自带上游 (BYOK)",
      "compare.row3.oss": "支持",
      "compare.row3.hosted": "支持",
      "compare.row4.label": "跨境支付 / 封号风险",
      "compare.row4.oss": "你扛",
      "compare.row4.hosted": "我们扛",
      "compare.row5.label": "子域 / 自定义域绑定",
      "compare.row5.oss": "自己配 Caddy",
      "compare.row5.hosted": "已配好",
      "final.title": "30 分钟后, 你也能有一个收款的中转店",
      "final.body": "注册免费, 不用绑信用卡, 不用谈号池。先开起来再说。",
      "final.cta_primary": "立即注册, 开店 →",
      "final.cta_secondary": "先看看套餐定价",
      "footer.license": "MIT 开源",
      "footer.legal": "独立开源项目。与 Anthropic / OpenAI 无任何隶属关系。默认上游 <code>api.llmapi.pro</code> 由独立第三方运营, 可在管理后台一键切换。"
    },
    en: {
      "meta.title": "3API Panel — launch your own Claude-compatible reseller store in 30 minutes",
      "meta.description": "No key sourcing, no API account negotiation — 3api ships with the llmapi.pro wholesale upstream built in. One-click deploy, integrate, and accept payments. MIT-licensed.",
      "nav.menu": "Menu",
      "nav.demo": "Demo",
      "nav.docs": "Docs",
      "nav.login": "Sign in",
      "nav.cta": "Get started →",
      "nav.lang_label": "Switch language",
      "nav.theme_label": "Toggle theme",
      "hero.title": "Launch your own Claude-compatible reseller store in 30 minutes",
      "hero.body": "No key pool to negotiate, no Anthropic console to wrestle with — 3api ships with the <strong>llmapi.pro wholesale upstream</strong> built in. Other open-source relay panels make you bring your own keys; here you can sell the day you sign up.",
      "hero.cta_primary": "Create a free panel →",
      "hero.cta_secondary": "I have a key, deploy with BYOK",
      "badge1.title": "One-command deploy",
      "badge1.sub": "<strong>docker compose up</strong><br>10-second self-host, or use the managed SaaS — same panel.",
      "badge2.title": "One-key upstream",
      "badge2.sub": "<strong>llmapi.pro wholesale, pre-wired</strong><br>Zero inventory — sign up today, ship to customers today.",
      "badge3.title": "One-click checkout",
      "badge3.sub": "<strong>Alipay / USDT ready out of the box</strong><br>Funds land in your account, the platform never touches them.",
      "why.title": "Why pick 3api",
      "why.subtitle": "Compared with rolling your own new-api / sub2api, here is what you skip.",
      "why.card1.kicker": "Zero inventory",
      "why.card1.title": "No key pool to source",
      "why.card1.body": "Other relay panels make you negotiate an Anthropic Console or OpenAI org key — days to weeks. 3api connects to the llmapi.pro wholesale upstream out of the box, top up $1.50 and you have a Claude-compatible API ready to sell.",
      "why.card2.kicker": "Platform-backed",
      "why.card2.title": "We swap when upstream breaks",
      "why.card2.body": "llmapi.pro maintains a multi-base upstream pool (official Anthropic plus Claude Code-compatible channels). If one channel breaks we fail over automatically — you sell, we keep the lights on.",
      "why.card3.kicker": "30-minute storefront",
      "why.card3.title": "Sign up → start selling",
      "why.card3.body": "Sign up → pick plans → wire Alipay / USDT → hand <code>&lt;slug&gt;.3api.pro</code> to customers. Subdomain and TLS are pre-provisioned; you never have to touch Caddy.",
      "quotes.title": "Operators talking",
      "quotes.subtitle": "Early closed-beta feedback. v0.4 will publish real case studies with revenue screenshots.",
      "quotes.q1.body": "\\"50 customers in two weeks. The best part: I never touched the Anthropic console — I just top up the wholesale account and set retail prices.\\"",
      "quotes.q1.who": "— Indie developer, reselling inside an overseas-student community",
      "quotes.q2.body": "\\"5K RMB / month with zero key sourcing. Anthropic ban risk is no longer mine; when upstream breaks, the platform swaps channels.\\"",
      "quotes.q2.who": "— Freelancer running a personal subscription site",
      "quotes.q3.body": "\\"Customers buy plans, I collect. Subscription + token dual-track, the back office settles automatically — I check the dashboard once a month.\\"",
      "quotes.q3.who": "— Small studio, Cursor power-user community",
      "self.title": "Developers can self-host too",
      "self.subtitle": "Not a fan of SaaS? Clone the repo, MIT-licensed, bring it up with Docker Compose.<br>Runs on Linux / macOS, and Windows via Docker Desktop.",
      "self.install_block": "<span class=\\"c\\"># Any machine with Docker works</span>\\ngit clone https://github.com/3api-pro/relay-panel\\ncd relay-panel\\ncp .env.example .env   <span class=\\"c\\"># set POSTGRES_PASSWORD / JWT_SECRET / UPSTREAM_KEY</span>\\ndocker compose up -d\\n<span class=\\"c\\"># → http://localhost:8080 → sign up → onboarding wizard → done</span>",
      "self.card1.title": "Wholesale upstream included",
      "self.card1.body": "No need to buy your own OpenAI / Anthropic key — install and you have a Claude-compatible API to sell. BYOK is supported too, toggle with one env var.",
      "self.card2.title": "Single & multi-tenant",
      "self.card2.body": "One codebase, two deployment modes: single-tenant self-host (your own domain) or multi-tenant SaaS (subdomain + custom domains + Caddy on-demand TLS).",
      "self.card3.title": "Modern stack",
      "self.card3.body": "Express + TypeScript + Postgres + Caddy + Next.js 14. Streaming SSE relay, token-bucket rate limiting, atomic balance accounting, idempotent purchases.",
      "compare.title": "Pick your deployment mode",
      "compare.col_cap": "Capability",
      "compare.col_oss": "Self-host (OSS)",
      "compare.col_hosted": "3api.pro hosted",
      "compare.row1.label": "Price",
      "compare.row1.oss": "Free",
      "compare.row1.hosted": "Zero ops",
      "compare.row2.label": "You operate the DB / box",
      "compare.row2.oss": "Yes",
      "compare.row2.hosted": "No",
      "compare.row3.label": "BYOK upstream",
      "compare.row3.oss": "Supported",
      "compare.row3.hosted": "Supported",
      "compare.row4.label": "Cross-border payments / ban risk",
      "compare.row4.oss": "On you",
      "compare.row4.hosted": "On us",
      "compare.row5.label": "Subdomain / custom-domain TLS",
      "compare.row5.oss": "Configure Caddy yourself",
      "compare.row5.hosted": "Pre-provisioned",
      "final.title": "30 minutes from now, you can have a paying reseller store",
      "final.body": "Free to sign up. No credit card, no key pool to negotiate. Get a store live first; iterate later.",
      "final.cta_primary": "Create a free panel →",
      "final.cta_secondary": "See the pricing first",
      "footer.license": "Open source under MIT",
      "footer.legal": "Independent project. Not affiliated with Anthropic / OpenAI. Default upstream <code>api.llmapi.pro</code> is operated by an independent provider; you can swap it from the admin panel."
    }
  };

  function getLocale() {
    var l = document.documentElement.getAttribute('data-lang');
    return (l === 'en' || l === 'zh') ? l : 'zh';
  }

  function applyLocale(locale) {
    if (locale !== 'zh' && locale !== 'en') return;
    document.documentElement.setAttribute('data-lang', locale);
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    var dict = STRINGS[locale] || STRINGS.zh;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-i18n');
      var val = dict[key];
      if (val == null) continue;
      var attrName = node.getAttribute('data-i18n-attr');
      if (attrName) {
        node.setAttribute(attrName, val);
        continue;
      }
      if (node.hasAttribute('data-i18n-html')) {
        node.innerHTML = val;
      } else {
        node.textContent = val;
      }
    }
    try { localStorage.setItem('3api_locale', locale); } catch(_){}
    try { document.cookie = '3api_locale=' + encodeURIComponent(locale) + '; Max-Age=31536000; Path=/; SameSite=Lax'; } catch(_){}
  }

  function applyTheme(t) {
    if (t !== 'light' && t !== 'dark') return;
    document.documentElement.classList.remove('light','dark');
    document.documentElement.classList.add(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('3api_theme', t); } catch(_){}
  }

  // Wire buttons after DOM is ready.
  document.addEventListener('DOMContentLoaded', function(){
    applyLocale(getLocale());
    var langBtn = document.getElementById('lang-toggle');
    if (langBtn) langBtn.addEventListener('click', function(){
      var cur = getLocale();
      applyLocale(cur === 'zh' ? 'en' : 'zh');
    });
    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) themeBtn.addEventListener('click', function(){
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  });
})();
</script>

</body>
</html>
`;

const NOT_FOUND_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>404 — 3api.pro</title>
<style>body{font-family:-apple-system,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:32px}.t{font-size:64px;font-weight:700;color:#0d9488;margin:0}p{color:#475569;margin:12px 0 24px}a{color:#0f766e;text-decoration:none}</style>
</head><body><div class="b"><div class="t">404</div><p>这是 3api.pro 根域。<br>站长登录请走 /admin/login，店铺访客请直接访问店铺地址 (例如 acme.3api.pro)。</p>
<p><a href="/">返回首页</a> · <a href="https://github.com/3api-pro/relay-panel">GitHub</a></p></div></body></html>`;

/**
 * Mount this BEFORE tenant routes. On the SaaS root domain (or www) it owns
 * the entire request lifecycle: GET / serves marketing, anything else is a
 * dedicated 404 — root domain has no tenant context, so leaking subdomain
 * pages here would confuse users.
 *
 * Subdomains fall through (`next()`) to /api/* and the static UI bundle.
 * Single-tenant deploys (no saasDomain configured) skip entirely.
 */
// Paths that ARE valid on the root domain (no tenant context required).
// Anything else on the root domain falls to a clean HTML 404 below.
const ROOT_DOMAIN_ALLOW: Array<RegExp> = [
  /^\/health$/,
  /^\/create\/?$/,                      // tenant signup form (UI page)
  /^\/login\/?$/,                       // reseller-admin login (UI page)
  /^\/pricing\/?$/,                     // host-aware: root marketing pricing
  /^\/admin(\/.*)?$/,                   // reseller admin console (UI + API)
  /^\/api\/admin(\/.*)?$/,              // admin API (login + authed routes)
  /^\/api\/signup-tenant(\/.*)?$/,      // public tenant signup API
  /^\/api\/health$/,                    // alias used by some monitors
  /^\/_next\//,                         // Next.js static assets
];

landingRouter.use((req: Request, res: Response, next) => {
  const host = (req.hostname || '').toLowerCase();
  const saas = (config.saasDomain || '').toLowerCase();
  if (!saas) return next();
  const isRoot = host === saas || host === `www.${saas}`;
  if (!isRoot) return next();

  if (req.method === 'GET' && (req.path === '/' || req.path === '')) {
    res.type('html').status(200).send(HTML);
    return;
  }
  if (ROOT_DOMAIN_ALLOW.some((re) => re.test(req.path))) return next();

  res.status(404).type('html').send(NOT_FOUND_HTML);
});
