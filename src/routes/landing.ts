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
<title>3API Panel — open-source Claude-compatible API reseller panel</title>
<meta name="description" content="自部署 / 托管 SaaS 双选的 Claude 兼容 API 中转分销面板。内置上游, 一键开店, MIT 开源。">
<style>
  :root { --ink: #0f172a; --mute: #475569; --line: #e2e8f0; --accent: #0d9488; --accent2: #0f766e; --bg: #f8fafc; }
  * { box-sizing: border-box; }
  html, body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif; color: var(--ink); background: var(--bg); -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  header { background: #fff; border-bottom: 1px solid var(--line); }
  header .row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; }
  header .brand { font-weight: 600; font-size: 18px; letter-spacing: -0.01em; }
  header .brand .dot { display: inline-block; width: 8px; height: 8px; background: var(--accent); border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  header nav a { margin-left: 20px; font-size: 14px; color: var(--mute); }
  header nav a:hover { color: var(--ink); }
  header nav .cta { background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 6px; }
  header nav .cta:hover { background: var(--accent2); color: #fff; }

  .hero { padding: 80px 0 60px; text-align: center; }
  .hero h1 { font-size: 44px; font-weight: 700; letter-spacing: -0.02em; margin: 0 auto; max-width: 800px; line-height: 1.15; }
  .hero p { color: var(--mute); font-size: 18px; max-width: 640px; margin: 24px auto 0; line-height: 1.6; }
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

  footer { padding: 32px 0; color: var(--mute); font-size: 13px; text-align: center; }
  footer a { color: var(--accent2); }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>

<header>
  <div class="wrap row">
    <div class="brand"><span class="dot"></span>3API Panel</div>
    <nav>
      <a href="https://github.com/3api-pro/relay-panel">GitHub</a>
      <a href="https://github.com/3api-pro/relay-panel#readme">Docs</a>
      <a href="https://github.com/3api-pro/relay-panel" class="cta">开始 →</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <h1>开源 Claude 兼容 API 分销面板, 内置上游, 5 分钟开店</h1>
    <p>
      给做 AI API 中转的同学一个起点。自部署一键装, 或用我们托管的多租户 SaaS。
      内置批发上游, 不需要自己谈号池。MIT 开源, 借鉴 one-api / new-api 的成熟模式。
    </p>
    <div class="ctas">
      <a href="/create/" class="btn primary">免费开店 →</a>
      <a href="https://github.com/3api-pro/relay-panel" class="btn ghost">在 GitHub 上自部署</a>
    </div>
    <div class="install" id="install">
      <pre><span class="c"># Ubuntu 22.04 / Debian / RHEL — 5 分钟一键装</span>
curl -fsSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/install.sh \\
  | DOMAIN=relay.example.com UPSTREAM_KEY=wsk-... bash</pre>
    </div>
  </div>
</section>

<section class="features">
  <div class="wrap">
    <h2>不一样的地方</h2>
    <div class="sub">跟 one-api / new-api 比, 多了什么</div>
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

<footer>
  <div class="wrap">
    Open source under MIT · <a href="https://github.com/3api-pro/relay-panel">github.com/3api-pro/relay-panel</a>
  </div>
</footer>

</body>
</html>
`;

const NOT_FOUND_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>404 — 3api.pro</title>
<style>body{font-family:-apple-system,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.b{text-align:center;padding:32px}.t{font-size:64px;font-weight:700;color:#0d9488;margin:0}p{color:#475569;margin:12px 0 24px}a{color:#0f766e;text-decoration:none}</style>
</head><body><div class="b"><div class="t">404</div><p>这是 3api.pro 根域。<br>分销面板要走子域 (例如 acme.3api.pro)。</p>
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
