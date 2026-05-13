/**
 * Marketing landing page served at GET / when the request lands on the
 * SaaS root domain (e.g. 3api.pro / www.3api.pro). Subdomains route to
 * tenant pages via tenantResolver elsewhere.
 *
 * Self-contained HTML — no asset pipeline. Replace with a real frontend
 * build when the marketing site grows past one page.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';

export const landingRouter = Router();

const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>3API Panel — 30 分钟开起你自己的 Claude 中转店, 零库存一键部署</title>
<meta name="description" content="不用谈号池, 不用自己买 API key — 3api 内置 llmapi.pro 批发上游, 一键部署 / 一键接入 / 一键支付, 30 分钟开起自己的 Claude 中转分销店。MIT 开源。">
<style>
  :root { --ink: #0f172a; --mute: #475569; --line: #e2e8f0; --accent: #0d9488; --accent2: #0f766e; --bg: #f8fafc; }
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  header { background: #fff; border-bottom: 1px solid var(--line); }
  header .row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; position: relative; }
  header .brand { font-weight: 600; font-size: 18px; letter-spacing: -0.01em; }
  header .brand .dot { display: inline-block; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  header nav a { margin-left: 20px; font-size: 14px; color: var(--mute); }
  header nav a:hover { color: var(--ink); }
  header nav .cta { background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 6px; }
  header nav .cta:hover { background: var(--accent2); color: #fff; }
  /* Mobile nav — CSS-only hamburger via checkbox-hack (no JS). */
  .nav-toggle { display: none; }
  .nav-burger { display: none; flex-direction: column; gap: 4px; cursor: pointer; padding: 8px; margin: -8px; border-radius: 6px; }
  .nav-burger:hover { background: var(--bg); }
  .nav-burger span { width: 22px; height: 2px; background: var(--ink); border-radius: 1px; transition: transform .15s, opacity .15s; }
  @media (max-width: 720px) {
    .nav-burger { display: flex; }
    header nav { display: none; position: absolute; top: 56px; right: 0; left: 0; flex-direction: column; padding: 8px 24px 16px; background: #fff; border-bottom: 1px solid var(--line); box-shadow: 0 6px 12px -8px rgba(15,23,42,0.18); z-index: 20; }
    header nav a { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 15px; }
    header nav a:last-child { border-bottom: 0; }
    header nav .cta { display: inline-block; align-self: flex-start; margin-top: 8px; padding: 10px 18px; }
    .nav-toggle:checked ~ nav { display: flex; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(1) { transform: translateY(6px) rotate(45deg); }
    .nav-toggle:checked ~ .nav-burger span:nth-child(2) { opacity: 0; }
    .nav-toggle:checked ~ .nav-burger span:nth-child(3) { transform: translateY(-6px) rotate(-45deg); }
  }

  .hero { padding: 80px 0 60px; text-align: center; }
  .hero h1 { font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin: 0 auto; max-width: 800px; line-height: 1.15; }
  .hero p { color: var(--mute); font-size: 18px; max-width: 640px; margin: 24px auto 0; line-height: 1.6; }
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
  .btn.ghost { border: 1px solid var(--line); background: #fff; color: var(--ink); }
  .btn.ghost:hover { border-color: #cbd5e1; }

  .install { margin: 28px auto 0; max-width: 720px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 14px 18px; border-radius: 8px; font-size: 13px; line-height: 1.6; text-align: left; overflow-x: auto; margin: 0; }
  pre .c { color: #64748b; }

  .features { padding: 60px 0; background: #fff; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .features h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .features .sub { text-align: center; color: var(--mute); margin-bottom: 40px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 22px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; }
  .card p { margin: 0; color: var(--mute); font-size: 14px; line-height: 1.6; }

  .compare { padding: 60px 0; }
  .compare h2 { text-align: center; font-size: 28px; margin: 0 0 24px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--line); font-size: 14px; }
  th { background: var(--bg); font-weight: 600; color: var(--mute); }
  tr:last-child td { border-bottom: 0; }
  td.y { color: var(--accent2); font-weight: 600; }
  td.n { color: #94a3b8; }

  .badges { padding: 28px 0 8px; }
  .badges .grid { gap: 18px; }
  .badge { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 22px; text-align: center; transition: border-color .15s, transform .15s; }
  .badge:hover { border-color: var(--accent); transform: translateY(-2px); }
  .badge .icon { display: inline-flex; align-items: center; justify-content: center; height: 40px; width: 40px; color: var(--accent); margin-bottom: 12px; }
  .badge h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); }
  .badge .sub { color: var(--mute); font-size: 13px; line-height: 1.5; }
  .badge .sub strong { color: var(--accent2); }

  .why { padding: 60px 0; }
  .why h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .why .sub-h { text-align: center; color: var(--mute); margin-bottom: 40px; }
  .why .card { background: #fff; }
  .why .card .kicker { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; color: var(--accent2); text-transform: uppercase; margin-bottom: 8px; }
  .why .card h3 { font-size: 18px; margin: 0 0 8px; }

  .testimonials { padding: 60px 0; background: #fff; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .testimonials h2 { text-align: center; font-size: 28px; margin: 0 0 8px; }
  .testimonials .sub-h { text-align: center; color: var(--mute); margin-bottom: 40px; font-size: 13px; }
  .quote { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 22px; }
  .quote p { margin: 0 0 12px; color: var(--ink); font-size: 15px; line-height: 1.55; }
  .quote .who { color: var(--mute); font-size: 13px; }

  .cta-final { padding: 80px 0; text-align: center; }
  .cta-final h2 { font-size: 32px; margin: 0 0 14px; letter-spacing: -0.01em; }
  .cta-final p { color: var(--mute); margin: 0 0 28px; }

  footer { padding: 32px 0; color: var(--mute); font-size: 13px; text-align: center; }
  footer a { color: var(--accent2); }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>

<header>
  <div class="wrap row">
    <div class="brand"><span class="dot"></span>3API Panel</div>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-hidden="true">
    <label for="nav-toggle" class="nav-burger" role="button" aria-label="菜单" aria-controls="primary-nav">
      <span></span><span></span><span></span>
    </label>
    <nav id="primary-nav">
      <a href="https://github.com/3api-pro/relay-panel">GitHub</a>
      <a href="/pricing">看演示</a>
      <a href="https://github.com/3api-pro/relay-panel#readme">Docs</a>
      <a href="/admin/login/">登录</a>
      <a href="/create/" class="cta">开始 →</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <h1>30 分钟, 开起你自己的 Claude 中转店</h1>
    <p>
      不用谈号池, 不用自己买 API key — 3api 内置 <strong style="color:var(--accent2)">llmapi.pro 批发上游</strong>, 开箱即用。
      其他开源中转面板要你自己拼号池, 这里注册就能卖。
    </p>
    <div class="ctas">
      <a href="/create/" class="btn primary">免费注册, 立即开店 →</a>
      <a href="https://github.com/3api-pro/relay-panel" class="btn ghost">我有 key, 想 BYOK 自部署</a>
    </div>
  </div>
</section>

<section class="badges">
  <div class="wrap">
    <div class="grid">
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg></div>
        <h3>一键部署</h3>
        <div class="sub"><strong>docker compose up</strong><br>10 秒起站, 也可托管 SaaS 注册即用</div>
      </div>
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg></div>
        <h3>一键接入</h3>
        <div class="sub"><strong>内置 llmapi 批发上游</strong><br>零库存 — 注册当天就能接客</div>
      </div>
      <div class="badge">
        <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg></div>
        <h3>一键支付</h3>
        <div class="sub"><strong>Alipay / USDT 配好即收款</strong><br>账款直接入站长账户, 平台不过手</div>
      </div>
    </div>
  </div>
</section>

<section class="why">
  <div class="wrap">
    <h2>为什么选 3api</h2>
    <div class="sub-h">和自部署 new-api / sub2api 比, 你省下的事</div>
    <div class="grid">
      <div class="card">
        <div class="kicker">零库存</div>
        <h3>不用谈号池</h3>
        <p>其他中转面板要你自己谈 Anthropic Console / OpenAI org key, 拿到要几天到几周。3api 一键接入 llmapi.pro 批发, ¥10 起充就有 Claude 兼容 API 可卖。</p>
      </div>
      <div class="card">
        <div class="kicker">平台兜底</div>
        <h3>上游挂了我们换</h3>
        <p>llmapi.pro 维护多 base 上游池 (Anthropic 官方 / Claude Code 兼容多通道), 单通道挂掉自动 failover。你只管卖, 不用半夜起来切 base。</p>
      </div>
      <div class="card">
        <div class="kicker">30 分钟开店</div>
        <h3>注册 → 接客</h3>
        <p>注册 → 选套餐 → 配 Alipay / USDT → 把 <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-size:13px">&lt;slug&gt;.3api.pro</code> 发给客户。子域和 TLS 都给你配好, 不用自己玩 Caddy。</p>
      </div>
    </div>
  </div>
</section>

<section class="testimonials">
  <div class="wrap">
    <h2>站长说</h2>
    <div class="sub-h">下面是早期内测站长的反馈, v0.4 会放真实 case study (含数据截图)</div>
    <div class="grid">
      <div class="quote">
        <p>"上线两周接了 50 个客户。最爽的是不用自己折腾 Anthropic Console — 充值到批发账户, 我只管定零售价。"</p>
        <div class="who">— 独立开发者, 留学生群转售</div>
      </div>
      <div class="quote">
        <p>"月入 5K, 不用谈号池。Anthropic 那边的封号风险跟我没关系, 上游挂了平台帮我换通道。"</p>
        <div class="who">— 自由职业者, 个人订阅站点</div>
      </div>
      <div class="quote">
        <p>"客户买套餐我躺赚。订阅 + Token 双轨, 后台自动出账, 我每月看一次结算。"</p>
        <div class="who">— 小工作室, Cursor 用户社区</div>
      </div>
    </div>
  </div>
</section>

<section class="features">
  <div class="wrap">
    <h2>开发者也可以自部署</h2>
    <div class="sub">不喜欢 SaaS? clone 仓库, MIT 开源, Docker Compose 起服务。<br>支持 Linux / macOS, 以及 Windows (Docker Desktop)。</div>
    <div class="install" id="install" style="margin-bottom:32px">
      <pre><span class="c"># 任意装了 Docker 的机器都可以跑</span>
git clone https://github.com/3api-pro/relay-panel
cd relay-panel
cp .env.example .env   <span class="c"># 改 POSTGRES_PASSWORD / JWT_SECRET / UPSTREAM_KEY</span>
docker compose up -d
<span class="c"># → http://localhost:8080 → 注册 → 引导向导 → 完成</span></pre>
    </div>
    <div class="grid">
      <div class="card">
        <h3>内置批发上游</h3>
        <p>不需要自己买 OpenAI / Anthropic key, 装完就有 Claude 兼容 API 可卖。也支持自带上游, 一个 env 变量切换。</p>
      </div>
      <div class="card">
        <h3>多租户托管模式</h3>
        <p>同一份代码两种部署: 单租户自部署 (你的域名), 或多租户跑 SaaS (子域 + 自定义域绑定 + Caddy on-demand TLS)。</p>
      </div>
      <div class="card">
        <h3>现代栈</h3>
        <p>Express + TypeScript + Postgres + Caddy + Next.js 14。SSE 流式中转、token 桶限流、原子额度扣费、幂等购买。</p>
      </div>
    </div>
  </div>
</section>

<section class="compare">
  <div class="wrap">
    <h2>选择你的部署方式</h2>
    <table>
      <tr>
        <th>能力</th>
        <th>自部署 (OSS)</th>
        <th>3api.pro 托管</th>
      </tr>
      <tr>
        <td>价格</td>
        <td class="y">免费</td>
        <td class="y">免运维</td>
      </tr>
      <tr>
        <td>需要自己运维 / DB</td>
        <td>是</td>
        <td>否</td>
      </tr>
      <tr>
        <td>自带上游 (BYOK)</td>
        <td class="y">支持</td>
        <td class="y">支持</td>
      </tr>
      <tr>
        <td>跨境支付 / 封号风险</td>
        <td>你扛</td>
        <td class="y">我们扛</td>
      </tr>
      <tr>
        <td>子域 / 自定义域绑定</td>
        <td>自己配 Caddy</td>
        <td class="y">已配好</td>
      </tr>
    </table>
  </div>
</section>

<section class="cta-final">
  <div class="wrap">
    <h2>30 分钟后, 你也能有一个收款的中转店</h2>
    <p>注册免费, 不用绑信用卡, 不用谈号池。先开起来再说。</p>
    <div class="ctas">
      <a href="/create/" class="btn primary">立即注册, 开店 →</a>
      <a href="/pricing" class="btn ghost">先看看套餐定价</a>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    Open source under MIT · <a href="https://github.com/3api-pro/relay-panel">github.com/3api-pro/relay-panel</a>
    <div style="margin-top:10px;font-size:12px;color:#94a3b8">
      Independent project. Not affiliated with Anthropic / OpenAI. Default upstream <code>api.llmapi.pro</code> is operated by an independent provider; swappable.
    </div>
  </div>
</footer>

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
