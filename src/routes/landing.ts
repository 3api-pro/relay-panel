/**
 * Marketing landing page served at GET / when the request lands on the
 * SaaS root domain (e.g. 3api.pro / www.3api.pro). Subdomains route to
 * tenant pages via tenantResolver elsewhere.
 *
 * Self-contained HTML — no asset pipeline. Bilingual (zh + en) and
 * dark-mode aware via the inline boot script + data-i18n attributes.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';

export const landingRouter = Router();

const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title data-i18n="meta.title">3API Panel — 为团队搭建 Claude 兼容 API 中转站</title>
<meta name="description" data-i18n-attr="content" data-i18n="meta.description" content="面向开发者与团队的 Claude 兼容 API 中转平台。内置订阅 / Token 计费、多租户后台、上游路由与 BYOK。开源 MIT。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%230d9488'/%3E%3Ctext x='16' y='22' text-anchor='middle' fill='white' font-family='system-ui' font-weight='700' font-size='14'%3E3%3C/text%3E%3C/svg%3E">
<script>
// Bootstrap theme + lang BEFORE first paint to avoid FOUC.
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
    --ink: #0b1220; --ink-soft: #1e293b; --mute: #475569; --mute-2: #64748b;
    --line: #e2e8f0; --line-strong: #cbd5e1;
    --accent: #0d9488; --accent-2: #0f766e; --accent-soft: rgba(13,148,136,0.10);
    --bg: #fafbfc; --bg-elev: #f1f5f9; --surface: #ffffff;
    --btn-ghost-bg: #ffffff; --shadow-soft: 0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.18);
    --hero-glow: radial-gradient(circle at 50% -20%, rgba(13,148,136,0.10), transparent 55%);
  }
  html.dark {
    --ink: #e2e8f0; --ink-soft: #cbd5e1; --mute: #94a3b8; --mute-2: #64748b;
    --line: #1f2937; --line-strong: #334155;
    --accent: #14b8a6; --accent-2: #2dd4bf; --accent-soft: rgba(20,184,166,0.14);
    --bg: #07101f; --bg-elev: #0f1a2d; --surface: #0e1729;
    --btn-ghost-bg: #0e1729; --shadow-soft: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px -20px rgba(0,0,0,0.75);
    --hero-glow: radial-gradient(circle at 50% -10%, rgba(20,184,166,0.18), transparent 55%);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; transition: background-color .2s ease, color .2s ease; }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }

  /* Header */
  header { background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 50; backdrop-filter: saturate(180%) blur(8px); }
  header .row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; position: relative; gap: 12px; }
  header .brand { display: inline-flex; align-items: center; font-weight: 600; font-size: 17px; letter-spacing: -0.01em; color: var(--ink); }
  header .brand .mark { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; font-size: 12px; font-weight: 700; margin-right: 10px; }
  header nav { display: flex; align-items: center; gap: 4px; }
  header nav a.link { font-size: 14px; color: var(--mute); padding: 8px 10px; border-radius: 6px; }
  header nav a.link:hover { color: var(--ink); background: var(--bg-elev); }
  header nav .cta { background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 7px; font-size: 14px; font-weight: 500; margin-left: 6px; }
  header nav .cta:hover { background: var(--accent-2); color: #fff; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 7px; color: var(--mute); cursor: pointer; background: transparent; border: 1px solid transparent; }
  .icon-btn:hover { color: var(--ink); background: var(--bg-elev); border-color: var(--line); }
  .icon-btn svg { width: 17px; height: 17px; }
  html.light .icon-btn .i-moon, html.dark .icon-btn .i-sun { display: inline-block; }
  html.light .icon-btn .i-sun, html.dark .icon-btn .i-moon { display: none; }
  .nav-toggle { display: none; }
  .nav-burger { display: none; flex-direction: column; gap: 4px; cursor: pointer; padding: 8px; margin: -8px; border-radius: 6px; }
  .nav-burger:hover { background: var(--bg-elev); }
  .nav-burger span { width: 22px; height: 2px; background: var(--ink); border-radius: 1px; transition: transform .15s, opacity .15s; }
  @media (max-width: 760px) {
    .nav-burger { display: flex; order: 3; }
    header .row { flex-wrap: wrap; }
    header nav { display: none; position: absolute; top: 56px; right: 0; left: 0; flex-direction: column; padding: 8px 24px 16px; background: var(--surface); border-bottom: 1px solid var(--line); box-shadow: var(--shadow-soft); z-index: 20; align-items: stretch; }
    header nav a.link { padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 15px; border-radius: 0; }
    header nav a.link:last-of-type { border-bottom: 0; }
    header nav .cta { display: inline-block; align-self: flex-start; margin: 8px 0 0; padding: 10px 18px; }
    header nav .icon-btn { margin: 8px 8px 0 0; align-self: flex-start; }
    .nav-toggle:checked ~ nav { display: flex; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
    .nav-toggle:checked ~ .nav-burger span:nth-child(2) { opacity: 0; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
  }

  /* Hero */
  .hero { position: relative; padding: 110px 0 90px; text-align: center; overflow: hidden; }
  .hero::before { content: ""; position: absolute; inset: 0; background: var(--hero-glow); pointer-events: none; }
  .hero > .wrap { position: relative; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; color: var(--mute); background: var(--surface); margin-bottom: 28px; }
  .eyebrow .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .hero h1 { font-size: 54px; font-weight: 700; letter-spacing: -0.025em; margin: 0 auto; max-width: 860px; line-height: 1.1; color: var(--ink); }
  .hero p.sub { color: var(--mute); font-size: 19px; max-width: 680px; margin: 24px auto 0; line-height: 1.6; }
  .hero p.sub strong { color: var(--ink-soft); font-weight: 600; }
  .hero .ctas { margin-top: 40px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .btn { padding: 13px 24px; border-radius: 8px; font-size: 15px; font-weight: 500; transition: transform .08s ease, background-color .12s ease, border-color .12s ease; display: inline-flex; align-items: center; gap: 8px; }
  .btn:active { transform: translateY(1px); }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-2); }
  .btn.ghost { border: 1px solid var(--line-strong); background: var(--btn-ghost-bg); color: var(--ink); }
  .btn.ghost:hover { border-color: var(--accent); color: var(--accent-2); }
  @media (max-width: 760px) {
    .hero { padding: 70px 0 60px; }
    .hero h1 { font-size: 34px; line-height: 1.18; }
    .hero p.sub { font-size: 16px; margin-top: 18px; padding: 0 4px; }
    .hero .ctas { margin-top: 28px; }
    .btn { padding: 11px 18px; font-size: 14px; }
  }

  /* Sections */
  section.feature, section.why, section.modes, section.final { padding: 80px 0; }
  section.feature { border-top: 1px solid var(--line); }
  .section-head { text-align: center; margin: 0 auto 56px; max-width: 700px; }
  .section-head h2 { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 12px; color: var(--ink); }
  .section-head p { color: var(--mute); font-size: 16px; margin: 0; line-height: 1.55; }

  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  @media (max-width: 760px) { .grid-3 { grid-template-columns: 1fr; gap: 16px; } }

  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 28px; transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease; }
  .card:hover { border-color: var(--line-strong); transform: translateY(-2px); box-shadow: var(--shadow-soft); }
  .card .ic { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); margin-bottom: 18px; }
  .card .ic svg { width: 20px; height: 20px; }
  .card h3 { margin: 0 0 8px; font-size: 17px; font-weight: 600; color: var(--ink); }
  .card p { margin: 0; color: var(--mute); font-size: 14px; line-height: 1.65; }
  .card code { background: var(--bg-elev); padding: 2px 6px; border-radius: 4px; font-size: 13px; color: var(--ink-soft); }

  .why .card .kicker { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; color: var(--accent-2); text-transform: uppercase; margin-bottom: 12px; }

  /* Compare */
  .modes { background: var(--bg-elev); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .compare-wrap { max-width: 820px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  th, td { padding: 14px 20px; text-align: left; border-bottom: 1px solid var(--line); font-size: 14px; color: var(--ink-soft); }
  th { background: var(--bg-elev); font-weight: 600; color: var(--mute); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
  th.cap-hosted { color: var(--accent-2); }
  tr:last-child td { border-bottom: 0; }
  td.label { color: var(--mute); }
  @media (max-width: 760px) {
    th, td { padding: 12px 14px; font-size: 13px; }
  }

  /* Final CTA */
  .final { text-align: center; }
  .final h2 { font-size: 36px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 14px; }
  .final p { color: var(--mute); font-size: 16px; margin: 0 0 32px; }
  @media (max-width: 760px) {
    .final h2 { font-size: 26px; }
    section.feature, section.why, section.modes, section.final { padding: 60px 0; }
    .section-head { margin-bottom: 36px; }
    .section-head h2 { font-size: 26px; }
  }

  /* Footer */
  footer { padding: 40px 0 48px; color: var(--mute); font-size: 13px; text-align: center; border-top: 1px solid var(--line); }
  footer a { color: var(--accent-2); }
  footer a:hover { text-decoration: underline; }
  footer code { background: var(--bg-elev); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  footer .legal { margin-top: 12px; font-size: 12px; opacity: 0.8; max-width: 720px; margin-left: auto; margin-right: auto; line-height: 1.55; }
</style>
</head>
<body>

<header>
  <div class="wrap row">
    <a href="/" class="brand"><span class="mark">3</span>3API Panel</a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
    <label for="nav-toggle" class="nav-burger" role="button" data-i18n-attr="aria-label" data-i18n="nav.menu" aria-label="菜单" aria-controls="primary-nav">
      <span></span><span></span><span></span>
    </label>
    <nav id="primary-nav">
      <a href="/pricing" class="link" data-i18n="nav.pricing">定价</a>
      <a href="https://github.com/3api-pro/relay-panel#readme" class="link" data-i18n="nav.docs">文档</a>
      <a href="https://github.com/3api-pro/relay-panel" class="link">GitHub</a>
      <a href="/admin/login/" class="link" data-i18n="nav.signin">登录</a>
      <a href="/create/" class="cta" data-i18n="nav.cta">创建账户</a>
      <button class="icon-btn" id="lang-toggle" type="button" data-i18n-attr="aria-label" data-i18n="nav.lang_label" aria-label="切换语言" title="EN / 中文">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>
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
    <div class="eyebrow"><span class="dot"></span><span data-i18n="hero.eyebrow">面向开发者与团队 · MIT 开源</span></div>
    <h1 data-i18n="hero.title">构建并运营你的 AI API 服务</h1>
    <p class="sub" data-i18n="hero.body" data-i18n-html="1">
      <strong>Claude 兼容的 API 中转平台</strong>。内置订阅与 Token 计费、多租户后台、上游路由与 BYOK — 主流客户端开箱即用。
    </p>
    <div class="ctas">
      <a href="/create/" class="btn primary" data-i18n="hero.cta_primary">免费创建账户 →</a>
      <a href="https://github.com/3api-pro/relay-panel" class="btn ghost" data-i18n="hero.cta_secondary">查看 GitHub</a>
    </div>
  </div>
</section>

<section class="feature">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="feat.title">核心能力</h2>
      <p data-i18n="feat.subtitle">运营一个对外的 AI API 服务需要的核心环节，3API Panel 已经替你装好。</p>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
        <h3 data-i18n="feat.card1.title">协议兼容</h3>
        <p data-i18n="feat.card1.body">兼容 Anthropic Messages API。Claude Code、Cursor、Cline、Continue 等主流客户端直连即用，无需修改 SDK。</p>
      </div>
      <div class="card">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></div>
        <h3 data-i18n="feat.card2.title">完整计费</h3>
        <p data-i18n="feat.card2.body">订阅、Token 套餐、每日签到、兑换码、Alipay / USDT 收款 — 业务运营所需的支付与额度环节全部内置。</p>
      </div>
      <div class="card">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg></div>
        <h3 data-i18n="feat.card3.title">上游可选</h3>
        <p data-i18n="feat.card3.body">可使用平台维护的批发上游池，也可绑定自有 Anthropic / OpenAI key (BYOK)，按优先级与模型 allowlist 自动路由。</p>
      </div>
    </div>
  </div>
</section>

<section class="why">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="why.title">为什么选择 3API Panel</h2>
      <p data-i18n="why.subtitle">与自行拼装一套相比，3API Panel 让你跳过基础设施层，直接进入产品与运营。</p>
    </div>
    <div class="grid-3">
      <div class="card">
        <div class="kicker" data-i18n="why.card1.kicker">零基础设施</div>
        <h3 data-i18n="why.card1.title">无需自采上游</h3>
        <p data-i18n="why.card1.body">平台维护批发上游池，注册后即可对外提供服务。无需自行采购 Anthropic 账号、维护 key 轮换、处理上游限流。</p>
      </div>
      <div class="card">
        <div class="kicker" data-i18n="why.card2.kicker">完整后台</div>
        <h3 data-i18n="why.card2.title">业务环节全覆盖</h3>
        <p data-i18n="why.card2.body">订阅生命周期、用户额度、用量统计、退款流程、事务邮件、Webhook 通知 — 运营所需的每一环都已实现并可定制。</p>
      </div>
      <div class="card">
        <div class="kicker" data-i18n="why.card3.kicker">数据自由</div>
        <h3 data-i18n="why.card3.title">托管或自托管</h3>
        <p data-i18n="why.card3.body">完整开源 (MIT 协议)。可使用 3api.pro 托管 SaaS，也可部署到任意支持 Docker 的服务器，数据完全归你所有。</p>
      </div>
    </div>
  </div>
</section>

<section class="modes">
  <div class="wrap">
    <div class="section-head">
      <h2 data-i18n="modes.title">两种部署方式</h2>
      <p data-i18n="modes.subtitle">同一份代码、同一套数据模型，你可以在两种模式之间自由迁移。</p>
    </div>
    <div class="compare-wrap">
      <table>
        <thead>
          <tr>
            <th data-i18n="modes.col_cap">能力</th>
            <th class="cap-hosted" data-i18n="modes.col_hosted">托管 (3api.pro)</th>
            <th data-i18n="modes.col_oss">自托管</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="label" data-i18n="modes.row1.label">上线时间</td>
            <td data-i18n="modes.row1.hosted">同日</td>
            <td data-i18n="modes.row1.oss">约 30 分钟（需 Docker 环境）</td>
          </tr>
          <tr>
            <td class="label" data-i18n="modes.row2.label">基础设施维护</td>
            <td data-i18n="modes.row2.hosted">由平台承担</td>
            <td data-i18n="modes.row2.oss">由站点方承担</td>
          </tr>
          <tr>
            <td class="label" data-i18n="modes.row3.label">数据存储</td>
            <td data-i18n="modes.row3.hosted">平台数据库</td>
            <td data-i18n="modes.row3.oss">本地数据库</td>
          </tr>
          <tr>
            <td class="label" data-i18n="modes.row4.label">自定义域名</td>
            <td data-i18n="modes.row4.hosted">内置，自动 TLS</td>
            <td data-i18n="modes.row4.oss">需自行配置反向代理</td>
          </tr>
          <tr>
            <td class="label" data-i18n="modes.row5.label">上游接入</td>
            <td data-i18n="modes.row5.hosted">批发池 + BYOK 均可</td>
            <td data-i18n="modes.row5.oss">BYOK 为主，可选接入批发池</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</section>

<section class="final">
  <div class="wrap">
    <h2 data-i18n="final.title">现在开始构建你的 AI API 服务</h2>
    <p data-i18n="final.body">免费创建账户，无需信用卡。先把服务跑起来，再根据规模决定是否升级。</p>
    <div class="ctas" style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
      <a href="/create/" class="btn primary" data-i18n="final.cta_primary">免费创建账户 →</a>
      <a href="/pricing" class="btn ghost" data-i18n="final.cta_secondary">查看套餐与定价</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <span data-i18n="footer.license">MIT 开源</span> · <a href="https://github.com/3api-pro/relay-panel">github.com/3api-pro/relay-panel</a>
    <div class="legal" data-i18n="footer.legal" data-i18n-html="1">
      独立开源项目。与 Anthropic、OpenAI 或任何上游厂商无任何隶属关系。默认上游 <code>api.llmapi.pro</code> 由独立第三方运营，可在管理后台一键切换。
    </div>
  </div>
</footer>

<script>
// Inline i18n + theme controller. Keeps the page self-contained.
(function(){
  var STRINGS = {
    zh: {
      "meta.title": "3API Panel — 为团队搭建 Claude 兼容 API 中转站",
      "meta.description": "面向开发者与团队的 Claude 兼容 API 中转平台。内置订阅 / Token 计费、多租户后台、上游路由与 BYOK。开源 MIT。",
      "nav.menu": "菜单",
      "nav.pricing": "定价",
      "nav.docs": "文档",
      "nav.signin": "登录",
      "nav.cta": "创建账户",
      "nav.lang_label": "切换语言",
      "nav.theme_label": "切换主题",
      "hero.eyebrow": "面向开发者与团队 · MIT 开源",
      "hero.title": "构建并运营你的 AI API 服务",
      "hero.body": "<strong>Claude 兼容的 API 中转平台</strong>。内置订阅与 Token 计费、多租户后台、上游路由与 BYOK — 主流客户端开箱即用。",
      "hero.cta_primary": "免费创建账户 →",
      "hero.cta_secondary": "查看 GitHub",
      "feat.title": "核心能力",
      "feat.subtitle": "运营一个对外的 AI API 服务需要的核心环节，3API Panel 已经替你装好。",
      "feat.card1.title": "协议兼容",
      "feat.card1.body": "兼容 Anthropic Messages API。Claude Code、Cursor、Cline、Continue 等主流客户端直连即用，无需修改 SDK。",
      "feat.card2.title": "完整计费",
      "feat.card2.body": "订阅、Token 套餐、每日签到、兑换码、Alipay / USDT 收款 — 业务运营所需的支付与额度环节全部内置。",
      "feat.card3.title": "上游可选",
      "feat.card3.body": "可使用平台维护的批发上游池，也可绑定自有 Anthropic / OpenAI key (BYOK)，按优先级与模型 allowlist 自动路由。",
      "why.title": "为什么选择 3API Panel",
      "why.subtitle": "与自行拼装一套相比，3API Panel 让你跳过基础设施层，直接进入产品与运营。",
      "why.card1.kicker": "零基础设施",
      "why.card1.title": "无需自采上游",
      "why.card1.body": "平台维护批发上游池，注册后即可对外提供服务。无需自行采购 Anthropic 账号、维护 key 轮换、处理上游限流。",
      "why.card2.kicker": "完整后台",
      "why.card2.title": "业务环节全覆盖",
      "why.card2.body": "订阅生命周期、用户额度、用量统计、退款流程、事务邮件、Webhook 通知 — 运营所需的每一环都已实现并可定制。",
      "why.card3.kicker": "数据自由",
      "why.card3.title": "托管或自托管",
      "why.card3.body": "完整开源 (MIT 协议)。可使用 3api.pro 托管 SaaS，也可部署到任意支持 Docker 的服务器，数据完全归你所有。",
      "modes.title": "两种部署方式",
      "modes.subtitle": "同一份代码、同一套数据模型，你可以在两种模式之间自由迁移。",
      "modes.col_cap": "能力",
      "modes.col_hosted": "托管 (3api.pro)",
      "modes.col_oss": "自托管",
      "modes.row1.label": "上线时间",
      "modes.row1.hosted": "同日",
      "modes.row1.oss": "约 30 分钟（需 Docker 环境）",
      "modes.row2.label": "基础设施维护",
      "modes.row2.hosted": "由平台承担",
      "modes.row2.oss": "由站点方承担",
      "modes.row3.label": "数据存储",
      "modes.row3.hosted": "平台数据库",
      "modes.row3.oss": "本地数据库",
      "modes.row4.label": "自定义域名",
      "modes.row4.hosted": "内置，自动 TLS",
      "modes.row4.oss": "需自行配置反向代理",
      "modes.row5.label": "上游接入",
      "modes.row5.hosted": "批发池 + BYOK 均可",
      "modes.row5.oss": "BYOK 为主，可选接入批发池",
      "final.title": "现在开始构建你的 AI API 服务",
      "final.body": "免费创建账户，无需信用卡。先把服务跑起来，再根据规模决定是否升级。",
      "final.cta_primary": "免费创建账户 →",
      "final.cta_secondary": "查看套餐与定价",
      "footer.license": "MIT 开源",
      "footer.legal": "独立开源项目。与 Anthropic、OpenAI 或任何上游厂商无任何隶属关系。默认上游 <code>api.llmapi.pro</code> 由独立第三方运营，可在管理后台一键切换。"
    },
    en: {
      "meta.title": "3API Panel — a Claude-compatible API gateway for teams",
      "meta.description": "A Claude-compatible API gateway for developers and teams. Built-in subscriptions, token billing, multi-tenant admin, upstream routing, and BYOK. Open source under MIT.",
      "nav.menu": "Menu",
      "nav.pricing": "Pricing",
      "nav.docs": "Docs",
      "nav.signin": "Sign in",
      "nav.cta": "Create account",
      "nav.lang_label": "Switch language",
      "nav.theme_label": "Toggle theme",
      "hero.eyebrow": "Built for developers and teams · MIT-licensed",
      "hero.title": "Build and run your own AI API service",
      "hero.body": "<strong>A Claude-compatible API gateway.</strong> Subscriptions, token billing, multi-tenant admin, upstream routing, and BYOK — every major client connects out of the box.",
      "hero.cta_primary": "Create a free account →",
      "hero.cta_secondary": "View on GitHub",
      "feat.title": "Core capabilities",
      "feat.subtitle": "Everything required to run a public-facing AI API service is already built in.",
      "feat.card1.title": "Protocol-compatible",
      "feat.card1.body": "Anthropic Messages API compatible. Claude Code, Cursor, Cline, Continue — every major client connects directly with no SDK changes.",
      "feat.card2.title": "Billing built in",
      "feat.card2.body": "Subscriptions, token packs, daily check-ins, redemption codes, Alipay / USDT checkout — every commerce surface ships ready.",
      "feat.card3.title": "Bring any upstream",
      "feat.card3.body": "Use the managed wholesale upstream pool, or bind your own Anthropic / OpenAI keys (BYOK). Priority and model allow-list drive automatic routing.",
      "why.title": "Why 3API Panel",
      "why.subtitle": "Skip the plumbing layer and go straight to product and operations.",
      "why.card1.kicker": "Zero infrastructure",
      "why.card1.title": "No upstream sourcing",
      "why.card1.body": "We maintain the wholesale upstream pool — sign up and you are ready to serve traffic. No Anthropic account procurement, no key rotation, no upstream rate-limit firefighting.",
      "why.card2.kicker": "Full back office",
      "why.card2.title": "Every operational surface, ready",
      "why.card2.body": "Subscription lifecycle, user quotas, usage analytics, refunds, transactional email, webhook notifications — implemented and customisable out of the box.",
      "why.card3.kicker": "Data portability",
      "why.card3.title": "Hosted or self-hosted",
      "why.card3.body": "Fully open source under MIT. Run on the hosted SaaS at 3api.pro, or deploy on any Docker-capable server — your data stays yours either way.",
      "modes.title": "Two deployment modes",
      "modes.subtitle": "One codebase, one data model. Move between hosted and self-hosted whenever it suits you.",
      "modes.col_cap": "Capability",
      "modes.col_hosted": "Hosted (3api.pro)",
      "modes.col_oss": "Self-hosted",
      "modes.row1.label": "Time to launch",
      "modes.row1.hosted": "Same day",
      "modes.row1.oss": "~30 minutes (Docker required)",
      "modes.row2.label": "Infrastructure",
      "modes.row2.hosted": "Managed by us",
      "modes.row2.oss": "Managed by you",
      "modes.row3.label": "Data location",
      "modes.row3.hosted": "Our database",
      "modes.row3.oss": "Your database",
      "modes.row4.label": "Custom domain",
      "modes.row4.hosted": "Included, auto-TLS",
      "modes.row4.oss": "Bring your own reverse proxy",
      "modes.row5.label": "Upstream",
      "modes.row5.hosted": "Wholesale pool + BYOK",
      "modes.row5.oss": "BYOK primary, wholesale optional",
      "final.title": "Start building your AI API service",
      "final.body": "Create a free account — no credit card required. Get the service running first; upgrade only when scale justifies it.",
      "final.cta_primary": "Create a free account →",
      "final.cta_secondary": "See plans and pricing",
      "footer.license": "Open source under MIT",
      "footer.legal": "Independent open-source project. Not affiliated with Anthropic, OpenAI, or any upstream vendor. The default upstream <code>api.llmapi.pro</code> is operated by an independent provider and is swappable from the admin panel."
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
<style>body{font-family:-apple-system,sans-serif;background:#fafbfc;color:#0b1220;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:32px}.t{font-size:64px;font-weight:700;color:#0d9488;margin:0}p{color:#475569;margin:12px 0 24px}a{color:#0f766e;text-decoration:none}</style>
</head><body><div class="b"><div class="t">404</div><p>这是 3api.pro 根域。<br>登录请走 /admin/login，访问已有站点请使用对应的子域 (如 acme.3api.pro)。</p>
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
const ROOT_DOMAIN_ALLOW: Array<RegExp> = [
  /^\/health$/,
  /^\/create\/?$/,
  /^\/login\/?$/,
  /^\/pricing\/?$/,
  /^\/admin(\/.*)?$/,
  /^\/api\/admin(\/.*)?$/,
  /^\/api\/signup-tenant(\/.*)?$/,
  /^\/api\/health$/,
  /^\/_next\//,
];

landingRouter.use((req: Request, res: Response, next) => {
  const host = (req.hostname || '').toLowerCase();
  const saas = (config.saasDomain || '').toLowerCase();
  if (!saas) return next();
  const isRoot = host === saas || host === `www.${saas}`;
  if (!isRoot) return next();

  if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/' || req.path === '')) {
    res.type('html').status(200).send(HTML);
    return;
  }
  if (ROOT_DOMAIN_ALLOW.some((re) => re.test(req.path))) return next();

  res.status(404).type('html').send(NOT_FOUND_HTML);
});
