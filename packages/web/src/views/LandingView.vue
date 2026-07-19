<script setup lang="ts">
/**
 * LandingView —— panel.3api.pro 登出态门面（获客漏斗）。
 *
 * 忠实移植自成品 landing-dashboard.html（已过老板 UI 红线），只做「搬进 Vue」的工程整合：
 *   · CSS 全部命名空间到 `.landing-root`（非 scoped，因为舰队表格行由 JS 动态注入，
 *     scoped 的 data 属性无法覆盖到运行时创建的节点）。类名/关键帧全部带命名空间防全局冲突。
 *   · 原生 JS 的「活舰队控制台」动画（滚动数字 / sparkline 漂移 / 批量任务循环 / 中英切换 /
 *     滚动揭示 / 顶栏阴影）搬进 onMounted，全部 setInterval / rAF / 事件监听 / IntersectionObserver /
 *     异步 sleep 循环在 onUnmounted 清理，防内存泄漏与路由切走后残留。
 *   · 保留组件自带的中英切换（不接 vue-i18n，维持成品原样最保真）；DOM 查询全部限定在组件根内。
 *   · 保留 prefers-reduced-motion 降级。
 *   · CTA 真链接：Start free→/signup，Sign in→/login（RouterLink）；Demo / GitHub→新标签外链。
 */
import { onMounted, onUnmounted, ref } from 'vue';

const rootRef = ref<HTMLElement | null>(null);

// ---- 清理登记表（onUnmounted 统一回收） ----
let destroyed = false;
let rafId = 0;
const intervals: number[] = [];
const timers = new Set<number>();
const sleepResolvers = new Set<() => void>();
let io: IntersectionObserver | null = null;
let onScroll: (() => void) | null = null;
const langHandlers: Array<{ el: Element; fn: EventListener }> = [];

type Lang = 'en' | 'zh';
interface Site {
  name: string;
  engine: string;
  ver: string;
  status: 'up' | 'warn';
  req: number;
  rate: number;
}
interface RowRef {
  el: HTMLElement;
  site: Site;
  data: number[];
  req: HTMLElement;
  area: SVGElement;
  line: SVGElement;
  apply: HTMLElement;
}
interface Roller {
  el: HTMLElement | null;
  cur: number;
  target: number;
  fmt: (n: number) => string;
}

onMounted(() => {
  const rootMaybe = rootRef.value;
  if (!rootMaybe) return;
  // 显式非 null 类型，供后续在 onMounted 内定义的动画闭包安全引用（闭包不继承块级窄化）
  const root: HTMLElement = rootMaybe;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ==========================================================
     i18n —— 完整 EN + ZH 文案，纯前端 DOM 交换。
     data-i18n = textContent ; data-i18n-html = innerHTML。
     查询限定在组件根（root）内，绝不触碰 document / 其它组件。
     ========================================================== */
  const I18N: Record<Lang, Record<string, string>> = {
    en: {
      'nav.product': 'Product', 'nav.pricing': 'Pricing', 'nav.demo': 'Demo', 'nav.docs': 'Docs',
      'nav.signin': 'Sign in', 'nav.start': 'Start free',
      'hero.eyebrow': '— control plane for LLM relays',
      'hero.h1': 'Run every LLM relay from <em class="ser">one</em> control plane.',
      'hero.lede': 'Spinning up a single relay is easy. Running many — different brands, domains and engine versions — means repeating deploys, upgrades, key rotations and dashboards for every instance, on every update. relay-panel does all of it once, across your whole fleet.',
      'cta.start': 'Start free', 'cta.demo': 'Watch live demo', 'cta.star': 'Star on GitHub',
      'trust.oss': 'Open source & self-hostable', 'trust.engine': 'Engines run unmodified', 'trust.isolate': 'Per-site data isolation',
      'con.title': 'Fleet overview', 'con.all': 'all sites',
      'con.s1': 'Active sites', 'con.s2': '24h requests', 'con.s3': '24h spend', 'con.s4': 'Gross margin',
      'con.h1': 'Site', 'con.h2': 'Engine', 'con.h3': '24h traffic', 'con.h4': 'Requests',
      'job.name': 'Rotate upstream key · claude-max group',
      'job.idle': 'Queued — applies to 5 sites',
      'job.running': 'Applying to', 'job.done': 'Applied to 5 / 5 sites · dry-run passed',
      'pain.line': 'One relay is a project. <b>Ten relays is a second job</b> — the same deploy, upgrade, key-swap and dashboard, multiplied by every instance, on every engine update.',
      'feat.eyebrow': 'What you get',
      'feat.title': 'Everything to operate a <em class="ser">fleet</em>, not just a server.',
      'f1.t': 'Full site lifecycle', 'f1.d': 'One-click provisioning, version-pinned upgrades with automatic rollback, start, stop and destroy — for every site you run.',
      'f2.t': 'Batch operations', 'f2.d': 'Change a channel across all sites at once. Rotate keys without opening each panel. Dry-run to preview the diff, then apply.',
      'f3.t': 'Onboard existing sites', 'f3.d': 'Bring an existing sub2api or new-api instance under unified management in five minutes. No migration, no data to move.',
      'f4.t': 'Channel marketplace + ledger', 'f4.d': 'Enable built-in upstream channel templates in one click. Usage → cost → margin is metered into a ledger automatically.',
      'f5.t': 'Alerts that reach you', 'f5.d': 'Site down, task failed, channel disabled, balance low — delivered by email and webhook the moment they happen.',
      'f6.t': 'Zero engine modification', 'f6.d': 'sub2api and new-api always run the official build. Upgrades stay effortless and fully AGPL-compliant.',
      'dep.eyebrow': 'Two ways to run it',
      'dep.title': 'Hosted or self-hosted. <em class="ser">Same</em> panel.',
      'dep.host.t': 'Hosted', 'dep.host.pill': 'MANAGED',
      'dep.host.d': 'We run the control plane on our infrastructure. You manage your relay stations and pay only for what you use, on a self-serve subscription. Zero ops on your side.',
      'dep.self.t': 'Self-hosted', 'dep.self.pill': 'OPEN SOURCE',
      'dep.self.d': 'One command on your own box. Fully open source, yours to read and extend. Data never leaves your infrastructure. Community beta.',
      'dep.self.cta': 'View on GitHub',
      'price.eyebrow': 'Pricing',
      'price.title': 'Start free. <em class="ser">Scale</em> when you do.',
      'price.mo': '/month', 'price.pop': 'MOST POPULAR',
      'price.free.n': 'Free', 'price.free.cap': 'Manage 1 relay station',
      'price.free.1': '1 relay station', 'price.free.2': 'Batch operations & dry-run', 'price.free.3': 'Community alerts', 'price.free.4': 'Self-host anytime',
      'price.pro.cap': 'Manage up to 5 stations', 'price.pro.cta': 'Start Pro',
      'price.pro.1': 'Everything in Free, plus', 'price.pro.2': '5 relay stations', 'price.pro.3': 'Channel marketplace + ledger', 'price.pro.4': 'Email + webhook alerts', 'price.pro.5': 'Version-pinned upgrades',
      'price.scale.n': 'Scale', 'price.scale.cap': 'Manage up to 20 stations', 'price.scale.cta': 'Start Scale',
      'price.scale.1': 'Everything in Pro, plus', 'price.scale.2': '20 relay stations', 'price.scale.3': 'Priority alerting', 'price.scale.4': 'Dry-run automation', 'price.scale.5': 'Priority support',
      'price.note': 'Every plan includes unmodified engines, per-site data isolation, and open-source self-hosting.',
      'final.title': 'Bring your whole relay fleet under <em class="ser">one</em> panel.',
      'final.self': 'or run it yourself — <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener">docker compose up →</a>',
      'foot.tag': 'The control plane for LLM relay fleets. Open-source beta.',
      'foot.product': 'Product', 'foot.overview': 'Overview', 'foot.demo': 'Live demo', 'foot.changelog': 'Changelog',
      'foot.resources': 'Resources', 'foot.docs': 'Docs', 'foot.selfhost': 'Self-host guide', 'foot.status': 'Status',
      'foot.company': 'Company', 'foot.contact': 'Contact', 'foot.rights': 'Open-source beta · self-host anytime',
    },
    zh: {
      'nav.product': '产品', 'nav.pricing': '价格', 'nav.demo': '演示', 'nav.docs': '文档',
      'nav.signin': '登录', 'nav.start': '免费开始',
      'hero.eyebrow': '· LLM 中转站控制平面',
      'hero.h1': '在<em class="ser">一个</em>控制台里，运营你的整支中转站舰队。',
      'hero.lede': '开一个中转站很容易。但同时管很多个——不同品牌、不同域名、不同引擎版本——就意味着为每个实例、每次更新，重复部署、升级、换 key 和看板。relay-panel 把这些只做一次，覆盖你的整支舰队。',
      'cta.start': '免费开始', 'cta.demo': '观看在线 Demo', 'cta.star': '去 GitHub 点 Star',
      'trust.oss': '开源，可自部署', 'trust.engine': '引擎零修改运行', 'trust.isolate': '每站数据隔离',
      'con.title': '舰队总览', 'con.all': '全部站点',
      'con.s1': '在线站点', 'con.s2': '24h 请求', 'con.s3': '24h 花费', 'con.s4': '毛利率',
      'con.h1': '站点', 'con.h2': '引擎', 'con.h3': '24h 流量', 'con.h4': '请求数',
      'job.name': '轮换上游 key · claude-max 分组',
      'job.idle': '排队中 — 将应用到 5 个站点',
      'job.running': '正在应用到', 'job.done': '已应用到 5 / 5 个站点 · 干跑通过',
      'pain.line': '一个中转站是一个项目。<b>十个中转站是第二份全职工作</b>——同样的部署、升级、换 key 和看板，乘以每一个实例、每一次引擎更新。',
      'feat.eyebrow': '你能得到什么',
      'feat.title': '运营一支<em class="ser">舰队</em>所需的一切，而不只是一台服务器。',
      'f1.t': '站点全生命周期', 'f1.d': '一键开站、钉版本升级带自动回滚、启动、停止与销毁——覆盖你运营的每一个站点。',
      'f2.t': '批量操作', 'f2.d': '一次改所有站点的渠道。换 key 不用逐站点打开面板。先干跑预览 diff，确认后再执行。',
      'f3.t': '接入已有站点', 'f3.d': '5 分钟把现有的 sub2api 或 new-api 实例接入统一管理。不用迁移，不用搬数据。',
      'f4.t': '渠道市场 + 分账账本', 'f4.d': '一键启用内置上游渠道模板。用量 → 成本 → 毛利，自动记入账本。',
      'f5.t': '能真正找到你的告警', 'f5.d': '站点宕机、任务失败、渠道停用、余额过低——发生的那一刻，通过邮件和 webhook 送达。',
      'f6.t': '引擎零修改', 'f6.d': 'sub2api 与 new-api 始终跑官方版本。升级毫无负担，完全符合 AGPL。',
      'dep.eyebrow': '两种运行方式',
      'dep.title': '托管，或自部署。<em class="ser">同一套</em>面板。',
      'dep.host.t': '托管', 'dep.host.pill': 'MANAGED',
      'dep.host.d': '控制平面跑在我们的基础设施上。你只管你的中转站，按需订阅、用多少付多少。你这边零运维。',
      'dep.self.t': '自部署', 'dep.self.pill': '开源',
      'dep.self.d': '在你自己的机器上一条命令搞定。完全开源，可读可改。数据永不离开你的基础设施。社区 Beta。',
      'dep.self.cta': '在 GitHub 查看',
      'price.eyebrow': '价格',
      'price.title': '免费开始，<em class="ser">随规模</em>成长。',
      'price.mo': '/月', 'price.pop': '最受欢迎',
      'price.free.n': '免费版', 'price.free.cap': '管理 1 个中转站',
      'price.free.1': '1 个中转站', 'price.free.2': '批量操作与干跑', 'price.free.3': '社区告警', 'price.free.4': '随时可自部署',
      'price.pro.cap': '最多管理 5 个站点', 'price.pro.cta': '开通专业版',
      'price.pro.1': '包含免费版全部，另加', 'price.pro.2': '5 个中转站', 'price.pro.3': '渠道市场 + 分账账本', 'price.pro.4': '邮件 + webhook 告警', 'price.pro.5': '钉版本升级',
      'price.scale.n': '规模版', 'price.scale.cap': '最多管理 20 个站点', 'price.scale.cta': '开通规模版',
      'price.scale.1': '包含专业版全部，另加', 'price.scale.2': '20 个中转站', 'price.scale.3': '优先告警', 'price.scale.4': '干跑自动化', 'price.scale.5': '优先支持',
      'price.note': '所有套餐均含：引擎零修改、每站数据隔离、可开源自部署。',
      'final.title': '把你的整支中转站舰队，收进<em class="ser">一个</em>面板。',
      'final.self': '或者自己跑 — <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener">docker compose up →</a>',
      'foot.tag': '面向 LLM 中转站舰队的控制平面。开源 Beta。',
      'foot.product': '产品', 'foot.overview': '总览', 'foot.demo': '在线演示', 'foot.changelog': '更新日志',
      'foot.resources': '资源', 'foot.docs': '文档', 'foot.selfhost': '自部署指南', 'foot.status': '状态',
      'foot.company': '公司', 'foot.contact': '联系我们', 'foot.rights': '开源 Beta · 随时可自部署',
    },
  };

  let curLang: Lang = 'en';
  function applyLang(lang: Lang): void {
    const dict = I18N[lang];
    curLang = lang;
    root.setAttribute('data-lang', lang);
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (!k) return;
      const v = dict[k];
      if (v != null) el.textContent = v;
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
      const k = el.getAttribute('data-i18n-html');
      if (!k) return;
      const v = dict[k];
      if (v != null) el.innerHTML = v;
    });
    root.querySelectorAll<HTMLElement>('[data-setlang]').forEach((b) => {
      b.setAttribute('aria-pressed', b.getAttribute('data-setlang') === lang ? 'true' : 'false');
    });
  }
  root.querySelectorAll<HTMLElement>('[data-setlang]').forEach((b) => {
    const fn: EventListener = () => {
      const l = b.getAttribute('data-setlang');
      if (l === 'en' || l === 'zh') applyLang(l);
    };
    b.addEventListener('click', fn);
    langHandlers.push({ el: b, fn });
  });

  /* ==========================================================
     LIVE FLEET CONSOLE —— 「活的产品演示」。
     纯模拟数据；中立 demo 域名（无真实基础设施）。
     ========================================================== */
  const SITES: Site[] = [
    { name: 'aurora-api.com', engine: 'sub2api', ver: 'v0.1.161', status: 'up', req: 1.24e6, rate: 1.0 },
    { name: 'nebula-relay.io', engine: 'new-api', ver: 'v2.9.3', status: 'up', req: 0.84e6, rate: 0.7 },
    { name: 'vertex-llm.co', engine: 'sub2api', ver: 'v0.1.161', status: 'up', req: 2.01e6, rate: 1.4 },
    { name: 'quasar-api.dev', engine: 'sub2api', ver: 'v0.1.160', status: 'warn', req: 0.32e6, rate: 0.4 },
    { name: 'lumen-relay.ai', engine: 'new-api', ver: 'v2.9.3', status: 'up', req: 0.97e6, rate: 0.8 },
  ];

  function fmtCompact(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toString();
  }
  function fmtYen(n: number): string {
    return '¥' + Math.round(n).toLocaleString('en-US');
  }

  function sparkPath(data: number[], w: number, h: number, close: boolean): string {
    const n = data.length;
    const step = w / (n - 1);
    let d = '';
    data.forEach((val, i) => {
      const x = (i * step).toFixed(1);
      const y = (h - 2 - val * (h - 4)).toFixed(1);
      d += i === 0 ? 'M' + x + ' ' + y : ' L' + x + ' ' + y;
    });
    if (close) d += ' L' + w + ' ' + h + ' L0 ' + h + ' Z';
    return d;
  }
  function seedSpark(base: number): number[] {
    const a: number[] = [];
    for (let i = 0; i < 16; i++) {
      a.push(Math.max(0.06, Math.min(0.96, base + (Math.random() - 0.5) * 0.5)));
    }
    return a;
  }

  // 模板静态保证这些 id 存在；非空断言取得非 null 类型，供后续闭包（tickUpdated/runJob）引用
  const table = root.querySelector<HTMLElement>('#con-table')!;
  const upEl = root.querySelector<HTMLElement>('#con-updated')!;
  const jobSub = root.querySelector<HTMLElement>('#job-sub')!;
  const jobFill = root.querySelector<HTMLElement>('#job-fill')!;
  const jobCount = root.querySelector<HTMLElement>('#job-count')!;

  const rowRefs: RowRef[] = [];
  SITES.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'trow site';
    const data = seedSpark(0.35 + s.rate * 0.18);
    row.innerHTML =
      '<div class="c-site"><span class="hdot ' + (s.status === 'warn' ? 'warn' : 'up') + '" style="color:' + (s.status === 'warn' ? 'var(--warn)' : 'var(--up)') + '"></span>' +
        '<span class="site-name">' + s.name + '</span></div>' +
      '<div class="c-engine">' + s.engine + ' <span class="ev">' + s.ver + '</span></div>' +
      '<div><svg class="spark" viewBox="0 0 66 22" preserveAspectRatio="none">' +
        '<path class="sp-area" d="' + sparkPath(data, 66, 22, true) + '" fill="rgba(109,139,255,.10)" stroke="none"/>' +
        '<path class="sp-line" d="' + sparkPath(data, 66, 22, false) + '" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linejoin="round" opacity="' + (s.status === 'warn' ? '.5' : '.85') + '"/>' +
      '</svg></div>' +
      '<div class="c-req">' + fmtCompact(s.req) + '</div>' +
      '<div class="c-apply"><span class="apply idle"></span></div>';
    table.appendChild(row);
    rowRefs.push({
      el: row,
      site: s,
      data,
      req: row.querySelector('.c-req') as HTMLElement,
      area: row.querySelector('.sp-area') as unknown as SVGElement,
      line: row.querySelector('.sp-line') as unknown as SVGElement,
      apply: row.querySelector('.apply') as HTMLElement,
    });
  });

  /* ----- 滚动数字（rAF 缓动逼近移动目标） ----- */
  const rollers: Roller[] = [];
  function addRoller(el: HTMLElement | null, val: number, fmt: (n: number) => string): Roller {
    const o: Roller = { el, cur: val, target: val, fmt };
    rollers.push(o);
    if (el) el.textContent = fmt(val);
    return o;
  }
  const elReq = root.querySelector<HTMLElement>('#st-req');
  const elCost = root.querySelector<HTMLElement>('#st-cost');
  const elMargin = root.querySelector<HTMLElement>('#st-margin');

  const totalReq0 = SITES.reduce((a, s) => a + s.req, 0); // ~5.38M
  const rTotReq = addRoller(elReq, totalReq0, fmtCompact);
  const rCost = addRoller(elCost, 12480, fmtYen);
  const rMargin = addRoller(elMargin, 63, (n) => Math.round(n) + '%');
  const rowRollers = rowRefs.map((r) => addRoller(r.req, r.site.req, fmtCompact));

  function frame(): void {
    if (destroyed) return;
    for (const r of rollers) {
      const d = r.target - r.cur;
      if (Math.abs(d) > (r.target > 1000 ? 50 : 0.4)) {
        r.cur += d * 0.08;
      } else {
        r.cur = r.target;
      }
      if (r.el) r.el.textContent = r.fmt(r.cur);
    }
    rafId = requestAnimationFrame(frame);
  }

  // 周期性抬高目标，让舰队始终显得「活着」且缓步上扬
  function bumpTargets(): void {
    rowRollers.forEach((roller, i) => {
      const s = SITES[i];
      if (!s) return;
      const inc = s.rate * (2200 + Math.random() * 4200);
      roller.target += inc;
      s.req = roller.target;
    });
    rTotReq.target = SITES.reduce((a, s) => a + s.req, 0);
    rCost.target = 12480 + (rTotReq.target - totalReq0) * 0.00235;
    rMargin.target = 61 + Math.round(Math.random() * 4); // 61-65%
  }

  /* ----- sparkline 漂移（实时流量感） ----- */
  function driftSparks(): void {
    rowRefs.forEach((r) => {
      r.data.shift();
      const last = r.data[r.data.length - 1] ?? 0.35;
      r.data.push(Math.max(0.06, Math.min(0.96, last + (Math.random() - 0.5) * 0.4)));
      r.area.setAttribute('d', sparkPath(r.data, 66, 22, true));
      r.line.setAttribute('d', sparkPath(r.data, 66, 22, false));
    });
  }

  /* ----- 「更新于 Xs 前」跳表 ----- */
  let upSec = 0;
  function tickUpdated(resetIt: boolean): void {
    if (resetIt) {
      upSec = 0;
      upEl.textContent = curLang === 'zh' ? '刚刚更新' : 'updated just now';
      return;
    }
    upSec++;
    upEl.textContent = curLang === 'zh' ? '更新于 ' + upSec + ' 秒前' : 'updated ' + upSec + 's ago';
  }

  /* ==========================================================
     BATCH JOB LOOP —— 批量操作滚过整支舰队：
     行 queued → applying(spinner) → done(check)，底部进度条填充，
     完成后暂停并复位。
     ========================================================== */
  const CHECK = '<svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
  function setApply(r: RowRef, stateName: 'queued' | 'idle' | 'running' | 'done'): void {
    const el = r.apply;
    el.className = 'apply ' + stateName;
    if (stateName === 'running') el.innerHTML = '<span class="spin"></span>';
    else if (stateName === 'done') el.innerHTML = CHECK;
    else el.innerHTML = '';
  }
  // 可中断 sleep：destroy 时立即结算所有 pending，让 await 链干净退出
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => {
      let id = 0;
      const done = (): void => {
        timers.delete(id);
        sleepResolvers.delete(done);
        res();
      };
      id = window.setTimeout(done, ms);
      timers.add(id);
      sleepResolvers.add(done);
    });
  }

  async function runJob(): Promise<void> {
    rowRefs.forEach((r) => setApply(r, 'queued'));
    jobFill.style.width = '0%';
    jobCount.textContent = '0 / ' + SITES.length;
    jobSub.textContent = I18N[curLang]['job.idle'] ?? '';
    await sleep(900);
    if (destroyed) return;

    for (const [i, r] of rowRefs.entries()) {
      setApply(r, 'running');
      jobSub.textContent = (I18N[curLang]['job.running'] ?? '') + ' ' + r.site.name + ' …';
      await sleep(620);
      if (destroyed) return;
      setApply(r, 'done');
      jobFill.style.width = Math.round(((i + 1) / SITES.length) * 100) + '%';
      jobCount.textContent = i + 1 + ' / ' + SITES.length;
      await sleep(180);
      if (destroyed) return;
    }
    jobSub.innerHTML = '<b>' + (I18N[curLang]['job.done'] ?? '') + '</b>';
    await sleep(2600);
  }

  async function jobLoop(): Promise<void> {
    if (reduce) {
      // 降级：直接展示完成后的静态态，不循环
      rowRefs.forEach((r) => setApply(r, 'done'));
      jobFill.style.width = '100%';
      jobCount.textContent = SITES.length + ' / ' + SITES.length;
      jobSub.innerHTML = '<b>' + (I18N[curLang]['job.done'] ?? '') + '</b>';
      return;
    }
    while (!destroyed) {
      await runJob();
    }
  }

  /* ========================================================== BOOT ========================================================== */
  applyLang('en');

  if (!reduce) {
    rafId = requestAnimationFrame(frame);
    intervals.push(window.setInterval(bumpTargets, 1700));
    intervals.push(window.setInterval(driftSparks, 2100));
    intervals.push(window.setInterval(() => tickUpdated(false), 1000));
    intervals.push(window.setInterval(() => tickUpdated(true), 9000));
  } else {
    tickUpdated(true);
  }
  void jobLoop();

  /* nav 滚动阴影 */
  const nav = root.querySelector<HTMLElement>('#nav');
  onScroll = (): void => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* 滚动揭示（轻量，仅一次） */
  if (!reduce && 'IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io?.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    root.querySelectorAll('.reveal').forEach((el) => io?.observe(el));
  } else {
    root.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
  }
});

onUnmounted(() => {
  destroyed = true;
  if (rafId) cancelAnimationFrame(rafId);
  intervals.forEach((id) => clearInterval(id));
  intervals.length = 0;
  timers.forEach((id) => clearTimeout(id));
  timers.clear();
  Array.from(sleepResolvers).forEach((r) => r());
  sleepResolvers.clear();
  if (io) {
    io.disconnect();
    io = null;
  }
  if (onScroll) {
    window.removeEventListener('scroll', onScroll);
    onScroll = null;
  }
  langHandlers.forEach((h) => h.el.removeEventListener('click', h.fn));
  langHandlers.length = 0;
});
</script>

<template>
  <div ref="rootRef" class="landing-root" data-lang="en">
    <div class="bg-field"></div>
    <div class="bg-glow"></div>
    <div class="bg-grain"></div>

    <!-- ============================== NAV ============================== -->
    <header class="nav" id="nav">
      <div class="wrap nav-in">
        <a class="brand" href="#top" aria-label="relay-panel">
          <span class="mark">
            <!-- lucide: layers -->
            <svg class="icon" viewBox="0 0 24 24"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12.5l8.58 3.91a2 2 0 0 0 1.66 0L21 12.5"/><path d="M2 17l8.58 3.91a2 2 0 0 0 1.66 0L21 17"/></svg>
          </span>
          relay-panel
        </a>
        <nav class="nav-links">
          <a href="#features" data-i18n="nav.product">Product</a>
          <a href="#pricing" data-i18n="nav.pricing">Pricing</a>
          <a href="https://demo.3api.pro" target="_blank" rel="noopener" data-i18n="nav.demo">Demo</a>
          <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener" data-i18n="nav.docs">Docs</a>
        </nav>
        <div class="nav-right">
          <div class="lang" role="group" aria-label="Language">
            <button data-setlang="en" aria-pressed="true">EN</button>
            <button data-setlang="zh" aria-pressed="false">中</button>
          </div>
          <RouterLink class="btn btn-ghost btn-sm" to="/login" data-i18n="nav.signin">Sign in</RouterLink>
          <RouterLink class="btn btn-primary btn-sm" to="/signup" data-i18n="nav.start">Start free</RouterLink>
        </div>
      </div>
    </header>

    <main id="top">
      <!-- ============================== HERO ============================== -->
      <section class="hero">
        <div class="wrap hero-grid">
          <!-- LEFT: copy -->
          <div class="hero-copy">
            <div class="eyebrow rise" style="--d:.02s"><b>relay-panel</b> <span data-i18n="hero.eyebrow">— control plane for LLM relays</span></div>
            <h1 class="rise" style="--d:.09s" data-i18n-html="hero.h1">Run every LLM relay from <em class="ser">one</em> control plane.</h1>
            <p class="lede rise" style="--d:.17s" data-i18n="hero.lede">Spinning up a single relay is easy. Running many — different brands, domains and engine versions — means repeating deploys, upgrades, key rotations and dashboards for every instance, on every update. relay-panel does all of it once, across your whole fleet.</p>
            <div class="hero-cta rise" style="--d:.25s">
              <RouterLink class="btn btn-primary" to="/signup">
                <span data-i18n="cta.start">Start free</span>
                <svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </RouterLink>
              <a class="btn btn-ghost" href="https://demo.3api.pro" target="_blank" rel="noopener">
                <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
                <span data-i18n="cta.demo">Watch live demo</span>
              </a>
              <a class="link-git" href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener">
                <svg class="icon" viewBox="0 0 24 24"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
                <svg class="icon star" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11.48 3.5a.56.56 0 0 1 1.04 0l2.12 5.11a.56.56 0 0 0 .48.35l5.52.44c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.19.56l1.29 5.38a.56.56 0 0 1-.84.61l-4.73-2.88a.56.56 0 0 0-.58 0l-4.73 2.88a.56.56 0 0 1-.84-.61l1.29-5.38a.56.56 0 0 0-.19-.56l-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44a.56.56 0 0 0 .48-.35Z"/></svg>
                <span data-i18n="cta.star">Star on GitHub</span>
              </a>
            </div>
            <div class="trust rise" style="--d:.33s">
              <span><svg class="icon" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg><span data-i18n="trust.oss">Open source &amp; self-hostable</span></span>
              <span><svg class="icon" viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M21 16v5h-5"/><path d="M3 16v5h5"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></svg><span data-i18n="trust.engine">Engines run unmodified</span></span>
              <span><svg class="icon" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg><span data-i18n="trust.isolate">Per-site data isolation</span></span>
            </div>
          </div>

          <!-- RIGHT: LIVE FLEET CONSOLE -->
          <div class="console rise" style="--d:.4s" aria-label="Live fleet overview (simulated)">
            <div class="con-head">
              <span class="mark"><svg class="icon" viewBox="0 0 24 24"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12.5l8.58 3.91a2 2 0 0 0 1.66 0L21 12.5"/><path d="M2 17l8.58 3.91a2 2 0 0 0 1.66 0L21 17"/></svg></span>
              <span class="con-title" data-i18n="con.title">Fleet overview</span>
              <span class="con-crumb">/ <span data-i18n="con.all">all sites</span></span>
              <span class="tag">PROD</span>
              <span class="live"><span class="dot"></span>LIVE</span>
              <span class="updated" id="con-updated">updated just now</span>
            </div>

            <div class="con-stats">
              <div class="stat"><div class="k" data-i18n="con.s1">Active sites</div><div class="v"><span id="st-sites">5</span><span class="u">/ 5</span></div></div>
              <div class="stat"><div class="k" data-i18n="con.s2">24h requests</div><div class="v" id="st-req">5.41M</div></div>
              <div class="stat"><div class="k" data-i18n="con.s3">24h spend</div><div class="v" id="st-cost">¥12,480</div></div>
              <div class="stat"><div class="k" data-i18n="con.s4">Gross margin</div><div class="v" id="st-margin">63%<span class="delta">▲</span></div></div>
            </div>

            <div class="con-table" id="con-table">
              <div class="trow head">
                <div data-i18n="con.h1">Site</div>
                <div data-i18n="con.h2">Engine</div>
                <div data-i18n="con.h3">24h traffic</div>
                <div style="text-align:right" data-i18n="con.h4">Requests</div>
                <div></div>
              </div>
              <!-- rows injected by JS in onMounted -->
            </div>

            <div class="con-job">
              <span class="job-ic"><svg class="icon" viewBox="0 0 24 24"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg></span>
              <div class="job-main">
                <div class="job-title"><span data-i18n="job.name">Rotate upstream key · claude-max group</span><span class="mtag" id="job-tag">DRY-RUN</span></div>
                <div class="job-sub" id="job-sub" data-i18n="job.idle">Queued — applies to 5 sites</div>
              </div>
              <div class="job-bar"><i id="job-fill"></i></div>
              <div class="job-count" id="job-count">0 / 5</div>
            </div>
          </div>
        </div>
      </section>

      <!-- ============================== PAIN BAND ============================== -->
      <section class="pain">
        <div class="wrap reveal">
          <p data-i18n-html="pain.line">One relay is a project. <b>Ten relays is a second job</b> — the same deploy, upgrade, key-swap and dashboard, multiplied by every instance, on every engine update.</p>
        </div>
      </section>

      <!-- ============================== FEATURES ============================== -->
      <section class="features" id="features">
        <div class="wrap">
          <div class="sec-head reveal">
            <div class="eyebrow" data-i18n="feat.eyebrow">What you get</div>
            <h2 data-i18n-html="feat.title">Everything to operate a <em class="ser">fleet</em>, not just a server.</h2>
          </div>
          <div class="fgrid reveal">
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg></div>
              <h3 data-i18n="f1.t">Full site lifecycle</h3>
              <p data-i18n="f1.d">One-click provisioning, version-pinned upgrades with automatic rollback, start, stop and destroy — for every site you run.</p>
            </div>
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg></div>
              <h3 data-i18n="f2.t">Batch operations</h3>
              <p data-i18n="f2.d">Change a channel across all sites at once. Rotate keys without opening each panel. Dry-run to preview the diff, then apply.</p>
            </div>
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg></div>
              <h3 data-i18n="f3.t">Onboard existing sites</h3>
              <p data-i18n="f3.d">Bring an existing sub2api or new-api instance under unified management in five minutes. No migration, no data to move.</p>
            </div>
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg></div>
              <h3 data-i18n="f4.t">Channel marketplace + ledger</h3>
              <p data-i18n="f4.d">Enable built-in upstream channel templates in one click. Usage → cost → margin is metered into a ledger automatically.</p>
            </div>
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/></svg></div>
              <h3 data-i18n="f5.t">Alerts that reach you</h3>
              <p data-i18n="f5.d">Site down, task failed, channel disabled, balance low — delivered by email and webhook the moment they happen.</p>
            </div>
            <div class="fcard">
              <div class="fic"><svg class="icon" viewBox="0 0 24 24"><path d="M16 16h6"/><path d="M19 13v6"/><path d="M12 3H3v18h9"/><path d="M3 9h18"/><path d="M9 3v6"/></svg></div>
              <h3 data-i18n="f6.t">Zero engine modification</h3>
              <p data-i18n="f6.d">sub2api and new-api always run the official build. Upgrades stay effortless and fully AGPL-compliant.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ============================== HOSTED vs SELF-HOSTED ============================== -->
      <section class="deploy">
        <div class="wrap">
          <div class="sec-head reveal">
            <div class="eyebrow" data-i18n="dep.eyebrow">Two ways to run it</div>
            <h2 data-i18n-html="dep.title">Hosted or self-hosted. <em class="ser">Same</em> panel.</h2>
          </div>
          <div class="dsplit reveal">
            <div class="dcard host">
              <div class="dhead">
                <span class="di"><svg class="icon" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg></span>
                <h3 data-i18n="dep.host.t">Hosted</h3>
                <span class="pill" data-i18n="dep.host.pill">MANAGED</span>
              </div>
              <p data-i18n="dep.host.d">We run the control plane on our infrastructure. You manage your relay stations and pay only for what you use, on a self-serve subscription. Zero ops on your side.</p>
              <RouterLink class="btn btn-primary" to="/signup"><span data-i18n="cta.start">Start free</span><svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></RouterLink>
            </div>
            <div class="dcard">
              <div class="dhead">
                <span class="di"><svg class="icon" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg></span>
                <h3 data-i18n="dep.self.t">Self-hosted</h3>
                <span class="pill" data-i18n="dep.self.pill">OPEN SOURCE</span>
              </div>
              <p data-i18n="dep.self.d">One command on your own box. Fully open source, yours to read and extend. Data never leaves your infrastructure. Community beta.</p>
              <div class="dcode"><span class="pr">$</span> docker compose up -d</div>
              <a class="btn btn-ghost" href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener"><svg class="icon" viewBox="0 0 24 24"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg><span data-i18n="dep.self.cta">View on GitHub</span></a>
            </div>
          </div>
        </div>
      </section>

      <!-- ============================== PRICING ============================== -->
      <section class="pricing" id="pricing">
        <div class="wrap">
          <div class="sec-head reveal">
            <div class="eyebrow" data-i18n="price.eyebrow">Pricing</div>
            <h2 data-i18n-html="price.title">Start free. <em class="ser">Scale</em> when you do.</h2>
          </div>
          <div class="pgrid reveal">
            <!-- Free -->
            <div class="pcard">
              <div class="pname" data-i18n="price.free.n">Free</div>
              <div class="price"><span class="amt">¥0</span></div>
              <div class="pcap" data-i18n="price.free.cap">Manage 1 relay station</div>
              <RouterLink class="btn btn-ghost" to="/signup" data-i18n="cta.start">Start free</RouterLink>
              <ul class="plist">
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.free.1">1 relay station</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.free.2">Batch operations &amp; dry-run</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.free.3">Community alerts</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.free.4">Self-host anytime</span></li>
              </ul>
            </div>
            <!-- Pro -->
            <div class="pcard pop">
              <div class="pname">Pro<span class="badge-pop" data-i18n="price.pop">MOST POPULAR</span></div>
              <div class="price"><span class="amt">¥29</span><span class="per" data-i18n="price.mo">/month</span></div>
              <div class="pcap" data-i18n="price.pro.cap">Manage up to 5 stations</div>
              <RouterLink class="btn btn-primary" to="/signup" data-i18n="price.pro.cta">Start Pro</RouterLink>
              <ul class="plist">
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.pro.1">Everything in Free, plus</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.pro.2">5 relay stations</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.pro.3">Channel marketplace + ledger</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.pro.4">Email + webhook alerts</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.pro.5">Version-pinned upgrades</span></li>
              </ul>
            </div>
            <!-- Scale -->
            <div class="pcard">
              <div class="pname" data-i18n="price.scale.n">Scale</div>
              <div class="price"><span class="amt">¥99</span><span class="per" data-i18n="price.mo">/month</span></div>
              <div class="pcap" data-i18n="price.scale.cap">Manage up to 20 stations</div>
              <RouterLink class="btn btn-ghost" to="/signup" data-i18n="price.scale.cta">Start Scale</RouterLink>
              <ul class="plist">
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.scale.1">Everything in Pro, plus</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.scale.2">20 relay stations</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.scale.3">Priority alerting</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.scale.4">Dry-run automation</span></li>
                <li><svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span data-i18n="price.scale.5">Priority support</span></li>
              </ul>
            </div>
          </div>
          <p class="pnote reveal" data-i18n="price.note">Every plan includes unmodified engines, per-site data isolation, and open-source self-hosting.</p>
        </div>
      </section>

      <!-- ============================== FINAL CTA ============================== -->
      <section class="cta">
        <div class="wrap">
          <div class="cta-box reveal">
            <h2 data-i18n-html="final.title">Bring your whole relay fleet under <em class="ser">one</em> panel.</h2>
            <div class="row">
              <RouterLink class="btn btn-primary" to="/signup"><span data-i18n="cta.start">Start free</span><svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></RouterLink>
              <a class="btn btn-ghost" href="https://demo.3api.pro" target="_blank" rel="noopener"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg><span data-i18n="cta.demo">Watch live demo</span></a>
            </div>
            <span class="self" data-i18n-html="final.self">or run it yourself — <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener">docker compose up →</a></span>
          </div>
        </div>
      </section>
    </main>

    <!-- ============================== FOOTER ============================== -->
    <footer>
      <div class="wrap">
        <div class="fgrid2">
          <div class="fcol fbrand">
            <a class="brand" href="#top"><span class="mark"><svg class="icon" viewBox="0 0 24 24"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12.5l8.58 3.91a2 2 0 0 0 1.66 0L21 12.5"/><path d="M2 17l8.58 3.91a2 2 0 0 0 1.66 0L21 17"/></svg></span>relay-panel</a>
            <p data-i18n="foot.tag">The control plane for LLM relay fleets. Open-source beta.</p>
          </div>
          <div class="fcol">
            <h4 data-i18n="foot.product">Product</h4>
            <a href="#features" data-i18n="foot.overview">Overview</a>
            <a href="#pricing" data-i18n="nav.pricing">Pricing</a>
            <a href="https://demo.3api.pro" target="_blank" rel="noopener" data-i18n="foot.demo">Live demo</a>
            <a href="https://github.com/3api-pro/relay-panel/releases" target="_blank" rel="noopener" data-i18n="foot.changelog">Changelog</a>
          </div>
          <div class="fcol">
            <h4 data-i18n="foot.resources">Resources</h4>
            <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener" data-i18n="foot.docs">Docs</a>
            <a href="https://github.com/3api-pro/relay-panel" target="_blank" rel="noopener">GitHub</a>
            <a href="https://github.com/3api-pro/relay-panel#self-host" target="_blank" rel="noopener" data-i18n="foot.selfhost">Self-host guide</a>
            <a href="https://demo.3api.pro" target="_blank" rel="noopener" data-i18n="foot.status">Status</a>
          </div>
          <div class="fcol">
            <h4 data-i18n="foot.company">Company</h4>
            <RouterLink to="/signup" data-i18n="nav.start">Start free</RouterLink>
            <RouterLink to="/login" data-i18n="nav.signin">Sign in</RouterLink>
            <a href="mailto:support@3api.pro" data-i18n="foot.contact">Contact</a>
          </div>
        </div>
        <div class="fbot">
          <span>© 2026 relay-panel</span>
          <span data-i18n="foot.rights">Open-source beta · self-host anytime</span>
          <div class="lang" role="group" aria-label="Language">
            <button data-setlang="en" aria-pressed="true">EN</button>
            <button data-setlang="zh" aria-pressed="false">中</button>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>

<!--
  非 scoped：舰队表格行由 JS 在 onMounted 动态注入，scoped 的 data 属性无法覆盖运行时节点。
  改为把所有选择器命名空间到 `.landing-root`（含元素选择器、媒体查询、关键帧前缀 landing-*），
  既防止样式泄漏到全局 / 其它视图，也防止全局 Tailwind preflight 意外影响本页。
-->
<style>
/* ============================================================
   TOKENS —— 近黑底 + 单一克制的长春花蓝 accent。
   语义状态色（绿/琥珀/红）仅用于「活」的控制台遥测数据，读作遥测而非装饰。
   全部 token 挂在 .landing-root 上，只对本页后代生效。
   ============================================================ */
.landing-root {
  --bg: #0a0b0c;
  --bg-1: #0d0e11; /* panels */
  --bg-2: #111318; /* raised surfaces */
  --bg-3: #161922; /* rows / inputs */
  --line: rgba(255, 255, 255, 0.075);
  --line-2: rgba(255, 255, 255, 0.12);
  --line-3: rgba(255, 255, 255, 0.2);
  --ink: #eceef1;
  --ink-2: #b6bcc6;
  --ink-3: #7c828d;
  --ink-4: #565b64;
  --accent: #6d8bff; /* the ONE brand accent */
  --accent-ink: #a7b6ff; /* lighter periwinkle for text emphasis */
  --accent-soft: rgba(109, 139, 255, 0.14);
  --up: #4ecb95;
  --warn: #e2b45f;
  --down: #ec6a55;
  --radius: 14px;
  --maxw: 1240px;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);

  /* 基座：独立 stacking context（isolation）+ 实底暗色，完整盖住全局环境光晕 */
  position: relative;
  isolation: isolate;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Hanken Grotesk', system-ui, sans-serif;
  font-weight: 400;
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
}

.landing-root * { box-sizing: border-box; }
.landing-root a { color: inherit; text-decoration: none; }
.landing-root button { font-family: inherit; cursor: pointer; border: 0; background: none; color: inherit; }
.landing-root ::selection { background: rgba(109, 139, 255, 0.28); color: #fff; }

/* Blueprint 背景：极淡工程网格，向边缘遮罩淡出。hero 后一处外科级 accent 辉光。
   z-index 0 位于 .landing-root（isolate）实底之上、内容（z-index 1）之下。 */
.landing-root .bg-field {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.022) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.022) 1px, transparent 1px);
  background-size: 56px 56px;
  background-position: center top;
  -webkit-mask-image: radial-gradient(120% 90% at 62% 0%, #000 30%, transparent 78%);
  mask-image: radial-gradient(120% 90% at 62% 0%, #000 30%, transparent 78%);
}
.landing-root .bg-glow {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(640px 460px at 74% 8%, rgba(109, 139, 255, 0.16), transparent 62%),
    radial-gradient(520px 520px at 8% 20%, rgba(109, 139, 255, 0.05), transparent 70%);
}
.landing-root .bg-grain {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.035;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
}

/* 内容层压在背景之上（header.nav 自带 z-index:50） */
.landing-root main,
.landing-root footer { position: relative; z-index: 1; }

.landing-root .wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 28px; }
@media (max-width: 560px) { .landing-root .wrap { padding: 0 18px; } }

/* ---------- shared bits ---------- */
.landing-root .eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.landing-root .eyebrow b { color: var(--accent-ink); font-weight: 600; }
.landing-root .ser { font-family: 'Instrument Serif', serif; font-style: italic; font-weight: 400; color: var(--accent-ink); }
.landing-root[data-lang='zh'] .ser { font-family: inherit; font-style: normal; font-weight: 500; }

.landing-root .icon {
  width: 1em;
  height: 1em;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex: none;
  display: inline-block;
  vertical-align: middle;
}

.landing-root .btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
  height: 44px;
  padding: 0 20px;
  border-radius: 11px;
  font-weight: 500;
  font-size: 15px;
  letter-spacing: -0.01em;
  transition: transform 0.18s var(--ease), background 0.18s, border-color 0.18s, color 0.18s;
}
.landing-root .btn .icon { width: 16px; height: 16px; }
.landing-root .btn-primary { background: var(--accent); color: #080a12; font-weight: 600; }
.landing-root .btn-primary:hover { background: #8098ff; transform: translateY(-1px); }
.landing-root .btn-ghost { border: 1px solid var(--line-2); color: var(--ink); background: rgba(255, 255, 255, 0.015); }
.landing-root .btn-ghost:hover { border-color: var(--line-3); background: rgba(255, 255, 255, 0.05); transform: translateY(-1px); }
.landing-root .btn-sm { height: 38px; padding: 0 15px; font-size: 14px; border-radius: 10px; }

/* ========================================================= NAV ========================================================= */
.landing-root header.nav {
  position: sticky;
  top: 0;
  z-index: 50;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background: linear-gradient(to bottom, rgba(10, 11, 12, 0.82), rgba(10, 11, 12, 0.5));
  border-bottom: 1px solid transparent;
  transition: border-color 0.3s, background 0.3s;
}
.landing-root header.nav.scrolled { border-bottom-color: var(--line); background: rgba(10, 11, 12, 0.9); }
.landing-root .nav-in { display: flex; align-items: center; gap: 26px; height: 66px; }
.landing-root .brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: 'Familjen Grotesk', sans-serif;
  font-weight: 600;
  font-size: 17px;
  letter-spacing: -0.02em;
}
.landing-root .brand .mark { width: 26px; height: 26px; color: var(--accent); }
.landing-root .brand .mark .icon { width: 26px; height: 26px; stroke-width: 1.7; }
.landing-root .nav-links { display: flex; gap: 4px; margin-left: 8px; }
.landing-root .nav-links a {
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 14.5px;
  color: var(--ink-2);
  transition: color 0.15s, background 0.15s;
}
.landing-root .nav-links a:hover { color: var(--ink); background: rgba(255, 255, 255, 0.04); }
.landing-root .nav-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }

.landing-root .lang {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line-2);
  border-radius: 9px;
  overflow: hidden;
  height: 34px;
}
.landing-root .lang button {
  padding: 0 11px;
  height: 100%;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink-3);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.02em;
  transition: color 0.15s, background 0.15s;
}
.landing-root .lang button[aria-pressed='true'] { color: var(--ink); background: rgba(255, 255, 255, 0.07); }

/* ========================================================= HERO ========================================================= */
.landing-root .hero { position: relative; padding: 78px 0 96px; }
.landing-root .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.04fr); gap: 60px; align-items: center; }
.landing-root .hero-copy { max-width: 560px; min-width: 0; }
.landing-root h1 {
  font-family: 'Familjen Grotesk', sans-serif;
  font-weight: 600;
  font-size: clamp(34px, 5.1vw, 62px);
  line-height: 1.03;
  letter-spacing: -0.032em;
  margin: 20px 0 0;
}
.landing-root .lede { margin: 24px 0 0; font-size: 18px; line-height: 1.6; color: var(--ink-2); max-width: 520px; }
.landing-root .hero-cta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 32px; }
.landing-root .link-git {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  color: var(--ink-3);
  padding: 8px 4px;
  transition: color 0.15s;
}
.landing-root .link-git:hover { color: var(--ink); }
.landing-root .link-git .icon { width: 16px; height: 16px; }
.landing-root .link-git .star { color: var(--warn); }
.landing-root .trust { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); }
.landing-root .trust span { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--ink-3); }
.landing-root .trust .icon { width: 15px; height: 15px; color: var(--up); }

/* ========================================================= LIVE FLEET CONSOLE ========================================================= */
.landing-root .console {
  position: relative;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--line-2);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  box-shadow: 0 40px 120px -50px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 255, 255, 0.04) inset;
  overflow: hidden;
}
.landing-root .console::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(109, 139, 255, 0.7) 40%, rgba(167, 182, 255, 0.9) 55%, transparent);
  opacity: 0.8;
}

.landing-root .con-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.landing-root .con-head .mark { width: 20px; height: 20px; color: var(--accent); }
.landing-root .con-head .mark .icon { width: 20px; height: 20px; stroke-width: 1.8; }
.landing-root .con-title { font-family: 'Familjen Grotesk', sans-serif; font-weight: 600; font-size: 14px; letter-spacing: -0.01em; }
.landing-root .con-crumb { color: var(--ink-4); font-size: 13px; }
.landing-root .tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--ink-3);
  border: 1px solid var(--line-2);
  border-radius: 5px;
  padding: 2px 6px;
}
.landing-root .live {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--up);
  letter-spacing: 0.04em;
}
.landing-root .live .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--up);
  box-shadow: 0 0 0 0 rgba(78, 203, 149, 0.5);
  animation: landing-pulse 2.4s infinite;
}
.landing-root .updated { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-4); }
@media (max-width: 440px) { .landing-root .con-crumb, .landing-root .updated { display: none; } }

/* stat strip */
.landing-root .con-stats { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
.landing-root .stat { padding: 14px 16px; border-right: 1px solid var(--line); }
.landing-root .stat:last-child { border-right: 0; }
.landing-root .stat .k { font-size: 11px; color: var(--ink-3); letter-spacing: 0.01em; margin-bottom: 6px; }
.landing-root .stat .v {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 500;
  font-size: 19px;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.landing-root .stat .v .u { color: var(--ink-3); font-size: 13px; margin-left: 2px; }
.landing-root .stat .delta { font-size: 10.5px; color: var(--up); font-family: 'JetBrains Mono', monospace; margin-left: 6px; }
@media (max-width: 560px) {
  .landing-root .con-stats { grid-template-columns: repeat(2, 1fr); }
  .landing-root .stat:nth-child(2) { border-right: 0; }
  .landing-root .stat:nth-child(1), .landing-root .stat:nth-child(2) { border-bottom: 1px solid var(--line); }
}

/* table */
.landing-root .con-table { padding: 4px 8px 8px; }
.landing-root .trow { display: grid; grid-template-columns: 1.7fr 0.95fr 68px 0.82fr 20px; align-items: center; gap: 10px; padding: 11px 8px; border-radius: 9px; }
.landing-root .trow.head {
  padding: 11px 8px 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-4);
}
.landing-root .trow.site { transition: background 0.2s; }
.landing-root .trow.site:hover { background: rgba(255, 255, 255, 0.028); }
.landing-root .trow.site + .trow.site { box-shadow: 0 -1px 0 var(--line); }
.landing-root .c-site { display: flex; align-items: center; gap: 10px; min-width: 0; }
.landing-root .hdot { width: 8px; height: 8px; border-radius: 50%; flex: none; position: relative; }
.landing-root .hdot.up { background: var(--up); animation: landing-breathe 3s ease-in-out infinite; }
.landing-root .hdot.warn { background: var(--warn); animation: landing-breathe 3s ease-in-out infinite; }
.landing-root .hdot.up::after, .landing-root .hdot.warn::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid currentColor;
  color: inherit;
  opacity: 0.25;
}
.landing-root .site-name {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.landing-root .c-engine { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-3); white-space: nowrap; }
.landing-root .c-engine .ev { color: var(--ink-4); }
.landing-root .spark { width: 66px; height: 22px; display: block; }
.landing-root .c-req { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }
.landing-root .c-apply { display: flex; justify-content: center; }
.landing-root .apply { width: 16px; height: 16px; display: grid; place-items: center; color: var(--ink-4); font-size: 12px; }
.landing-root .apply.queued { color: var(--ink-4); }
.landing-root .apply.queued::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.6; }
.landing-root .apply.idle::before { content: '–'; color: var(--ink-4); font-family: 'JetBrains Mono', monospace; }
.landing-root .spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.6px solid var(--line-3);
  border-top-color: var(--accent);
  animation: landing-spin 0.7s linear infinite;
}
.landing-root .apply .icon { width: 14px; height: 14px; color: var(--up); }
@media (max-width: 560px) {
  .landing-root .trow { grid-template-columns: 1.5fr 60px 0.8fr 20px; }
  .landing-root .c-engine { display: none; }
}

/* batch job footer */
.landing-root .con-job { display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-top: 1px solid var(--line); background: rgba(255, 255, 255, 0.018); }
.landing-root .job-ic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); flex: none; }
.landing-root .job-ic .icon { width: 15px; height: 15px; }
.landing-root .job-main { min-width: 0; flex: 1; }
.landing-root .job-title { font-size: 12.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.landing-root .job-title .mtag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--accent-ink);
  border: 1px solid rgba(109, 139, 255, 0.35);
  border-radius: 4px;
  padding: 1px 5px;
}
.landing-root .job-sub {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--ink-3);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.landing-root .job-sub b { color: var(--up); font-weight: 500; }
.landing-root .job-bar { width: 96px; height: 5px; border-radius: 3px; background: var(--bg-3); overflow: hidden; flex: none; }
.landing-root .job-bar > i {
  display: block;
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--accent), var(--accent-ink));
  transition: width 0.45s var(--ease);
}
.landing-root .job-count { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; flex: none; min-width: 34px; text-align: right; }
@media (max-width: 440px) { .landing-root .job-bar { display: none; } }

/* ========================================================= SECTIONS ========================================================= */
.landing-root section { position: relative; }
.landing-root .sec-head { max-width: 640px; }
.landing-root .sec-head h2 {
  font-family: 'Familjen Grotesk', sans-serif;
  font-weight: 600;
  font-size: clamp(27px, 3.4vw, 38px);
  line-height: 1.08;
  letter-spacing: -0.028em;
  margin: 14px 0 0;
}
.landing-root .sec-head p { color: var(--ink-2); font-size: 17px; margin: 14px 0 0; max-width: 560px; }

/* pain band */
.landing-root .pain { padding: 34px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.landing-root .pain p {
  font-family: 'Familjen Grotesk', sans-serif;
  font-weight: 500;
  font-size: clamp(20px, 2.6vw, 29px);
  line-height: 1.3;
  letter-spacing: -0.02em;
  color: var(--ink-3);
  max-width: 880px;
  margin: 0;
}
.landing-root .pain p b { color: var(--ink); }

/* features */
.landing-root .features { padding: 88px 0; }
.landing-root .fgrid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin-top: 52px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
}
.landing-root .fcard { background: var(--bg-1); padding: 30px 26px 34px; transition: background 0.25s; }
.landing-root .fcard:hover { background: var(--bg-2); }
.landing-root .fic {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  color: var(--accent-ink);
  margin-bottom: 20px;
}
.landing-root .fic .icon { width: 19px; height: 19px; stroke-width: 1.8; }
.landing-root .fcard h3 { font-family: 'Familjen Grotesk', sans-serif; font-weight: 600; font-size: 17.5px; letter-spacing: -0.015em; margin: 0 0 9px; }
.landing-root .fcard p { color: var(--ink-3); font-size: 14.5px; line-height: 1.58; margin: 0; }
@media (max-width: 900px) { .landing-root .fgrid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 560px) { .landing-root .fgrid { grid-template-columns: 1fr; } }

/* deploy split */
.landing-root .deploy { padding: 40px 0 88px; }
.landing-root .dsplit { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 48px; }
.landing-root .dcard { border: 1px solid var(--line-2); border-radius: 16px; padding: 30px 28px 28px; background: var(--bg-1); position: relative; overflow: hidden; }
.landing-root .dcard.host { background: linear-gradient(180deg, rgba(109, 139, 255, 0.06), var(--bg-1) 60%); }
.landing-root .dhead { display: flex; align-items: center; gap: 11px; margin-bottom: 16px; }
.landing-root .dhead .di { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; border: 1px solid var(--line-2); background: var(--bg-3); color: var(--accent-ink); }
.landing-root .dhead .di .icon { width: 17px; height: 17px; }
.landing-root .dhead h3 { font-family: 'Familjen Grotesk', sans-serif; font-weight: 600; font-size: 19px; letter-spacing: -0.02em; margin: 0; }
.landing-root .dhead .pill {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
  border: 1px solid var(--line-2);
  border-radius: 5px;
  padding: 2px 7px;
  margin-left: auto;
}
.landing-root .dcard p { color: var(--ink-2); font-size: 15px; line-height: 1.6; margin: 0 0 20px; }
.landing-root .dcode {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
  color: var(--ink-2);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  margin: 0 0 20px;
  display: flex;
  align-items: center;
  gap: 9px;
  overflow-x: auto;
}
.landing-root .dcode .pr { color: var(--accent-ink); }
.landing-root .dcard .btn { width: 100%; justify-content: center; }
@media (max-width: 760px) { .landing-root .dsplit { grid-template-columns: 1fr; } }

/* pricing */
.landing-root .pricing { padding: 40px 0 92px; }
.landing-root .pgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 52px; align-items: stretch; }
.landing-root .pcard { border: 1px solid var(--line-2); border-radius: 16px; padding: 28px 26px; background: var(--bg-1); display: flex; flex-direction: column; position: relative; }
.landing-root .pcard.pop { border-color: transparent; background: var(--bg-2); }
.landing-root .pcard.pop::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  padding: 1.5px;
  background: linear-gradient(160deg, rgba(109, 139, 255, 0.9), rgba(167, 182, 255, 0.25) 45%, transparent 70%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.landing-root .pname { display: flex; align-items: center; gap: 10px; font-family: 'Familjen Grotesk', sans-serif; font-weight: 600; font-size: 16px; letter-spacing: -0.01em; }
.landing-root .badge-pop {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.07em;
  color: var(--accent-ink);
  background: var(--accent-soft);
  border: 1px solid rgba(109, 139, 255, 0.3);
  border-radius: 5px;
  padding: 2px 6px;
  margin-left: auto;
}
.landing-root .price { margin: 18px 0 4px; font-family: 'Familjen Grotesk', sans-serif; letter-spacing: -0.03em; }
.landing-root .price .amt { font-size: 40px; font-weight: 600; }
.landing-root .price .per { color: var(--ink-3); font-size: 15px; font-weight: 400; }
.landing-root .pcap { color: var(--ink-3); font-size: 13.5px; min-height: 20px; }
.landing-root .pcard .btn { width: 100%; justify-content: center; margin: 22px 0 24px; }
.landing-root .pcard.pop .btn:not(.btn-primary) { border-color: var(--line-3); }
.landing-root .plist { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 11px; }
.landing-root .plist li { display: flex; gap: 10px; font-size: 14px; color: var(--ink-2); line-height: 1.4; }
.landing-root .plist .icon { width: 16px; height: 16px; color: var(--accent); flex: none; margin-top: 2px; }
.landing-root .pnote { text-align: center; color: var(--ink-4); font-size: 13px; margin-top: 26px; }
@media (max-width: 820px) { .landing-root .pgrid { grid-template-columns: 1fr; max-width: 420px; margin-left: auto; margin-right: auto; } }

/* final cta */
.landing-root .cta { padding: 20px 0 96px; }
.landing-root .cta-box {
  position: relative;
  border: 1px solid var(--line-2);
  border-radius: 20px;
  overflow: hidden;
  padding: 64px 40px;
  text-align: center;
  background: radial-gradient(120% 140% at 50% -10%, rgba(109, 139, 255, 0.16), var(--bg-1) 60%);
}
.landing-root .cta-box h2 {
  font-family: 'Familjen Grotesk', sans-serif;
  font-weight: 600;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.06;
  letter-spacing: -0.03em;
  margin: 0 auto;
  max-width: 640px;
}
.landing-root .cta-box .row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 30px; }
.landing-root .cta-box .self { display: block; margin-top: 20px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--ink-3); }
.landing-root .cta-box .self a { color: var(--accent-ink); border-bottom: 1px solid transparent; transition: border-color 0.15s; }
.landing-root .cta-box .self a:hover { border-color: var(--accent-ink); }

/* footer */
.landing-root footer { border-top: 1px solid var(--line); padding: 56px 0 40px; }
.landing-root .fgrid2 { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; gap: 36px; }
.landing-root .fcol h4 {
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--ink-4);
  text-transform: uppercase;
  font-family: 'JetBrains Mono', monospace;
  margin: 0 0 16px;
  font-weight: 500;
}
.landing-root .fcol a { display: block; color: var(--ink-2); font-size: 14px; padding: 5px 0; transition: color 0.15s; }
.landing-root .fcol a:hover { color: var(--ink); }
.landing-root .fbrand .brand { margin-bottom: 14px; }
.landing-root .fbrand p { color: var(--ink-3); font-size: 13.5px; max-width: 260px; margin: 0; }
.landing-root .fbot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 44px; padding-top: 24px; border-top: 1px solid var(--line); color: var(--ink-4); font-size: 13px; }
.landing-root .fbot .lang { margin-left: auto; }
@media (max-width: 760px) {
  .landing-root .fgrid2 { grid-template-columns: 1fr 1fr; gap: 28px; }
  .landing-root .fbrand { grid-column: 1 / -1; }
}

/* ========================================================= MOTION ========================================================= */
@keyframes landing-pulse {
  0% { box-shadow: 0 0 0 0 rgba(78, 203, 149, 0.5); }
  70% { box-shadow: 0 0 0 7px rgba(78, 203, 149, 0); }
  100% { box-shadow: 0 0 0 0 rgba(78, 203, 149, 0); }
}
@keyframes landing-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@keyframes landing-spin { to { transform: rotate(360deg); } }
@keyframes landing-rise { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: none; } }

.landing-root .rise { opacity: 0; animation: landing-rise 0.8s var(--ease) both; animation-delay: var(--d, 0s); }
.landing-root .reveal { opacity: 0; transform: translateY(18px); transition: opacity 0.7s var(--ease), transform 0.7s var(--ease); }
.landing-root .reveal.in { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  .landing-root .rise, .landing-root .reveal { opacity: 1 !important; transform: none !important; animation: none !important; }
  .landing-root .hdot, .landing-root .live .dot { animation: none !important; }
  .landing-root .spin { animation: none !important; }
}

/* nav responsive */
@media (max-width: 860px) { .landing-root .nav-links { display: none; } }
@media (max-width: 520px) { .landing-root .nav-right .btn-ghost { display: none; } }
@media (max-width: 980px) {
  .landing-root .hero-grid { grid-template-columns: minmax(0, 1fr); gap: 44px; }
  .landing-root .hero { padding: 52px 0 68px; }
  .landing-root .hero-copy { max-width: none; }
}
</style>
