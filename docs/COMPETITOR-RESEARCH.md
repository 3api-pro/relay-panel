# Competitor UI/UX Deep Research (2026-05-12)

Research agent's deep-dive into the 4 leading open-source API relay panels —
new-api / sub2api / VoAPI / Veloera — with one-api as legacy baseline.
Source: cloned repos read directly, not marketing claims. Used to plan v0.2.

## Section 1: Product snapshot

| Product | Stars | Stack | Theme switch | i18n | Charts | Table style | Unique features |
|---|---:|---|---|---|---|---|---|
| **QuantumNous/new-api** | 32.5k | Go + React 19 + shadcn/ui + TanStack (Router/Query/Table) + recharts | Light/dark + custom | en/zh + 4 | recharts | Dense + bulk + filter | workspace-aware nav, model price page, scheduled health-check on channels, per-plan USD limit, OAuth Anthropic/Codex import |
| **Wei-Shaw/sub2api** | 19.9k | Go + Gin + Vue3+TS + Element-Plus + ECharts | Light/dark + auto | en/zh | ECharts | Sparse + rainbow stat cards | **OAuth-as-upstream-identity** (Anthropic/Codex/Gemini OAuth pool), 拼车 marketing on top, multi-key per channel, daily check-in |
| **VoAPI** | 1.0k | Go + binary-only frontend (closed source, MIT shell only) | Yes | en/zh | unknown | unknown | Polished landing only; community-tier source not shipped (anti-pattern: cannot learn from binary) |
| **Veloera** | 1.6k | Go (fork of new-api) | Inherited | Inherited | Inherited | Inherited | **README declares project DEAD** — anti-pattern: do not waste time forking dead forks |
| **one-api** (legacy) | 33.5k | Go + Berry React (CRA) + AntD | Light/dark | 5 langs but stale | recharts | Dense | Group/User pricing tiers, redemption code marketing, multi-provider adapter |
| **3api** (us, current) | n/a | Node TS + Next.js 14 + Tailwind | **❌ none** | zh only | inline SVG | Tailwind dense | Multi-tenant SaaS, wholesale upstream, atomic order engine, Alipay+USDT |

## Section 2: Inheritance Plan — 23 items, prioritized

### P0 — v0.2 must-do (6 items)

#### 1. [P0] Light/dark theme switcher
**对标自**: new-api `default` theme + sub2api auto-switch
**3api 现状**: 无（永远 light）
**该做什么**: Tailwind dark: variants + class-based switcher in localStorage + system-prefers-color-scheme detection. Header toggle button.
**工程量估**: 4-6 hours
**为什么 P0**: 单一最大可见 polish 提升；4/5 竞品都有，缺它显得 unprofessional。

#### 2. [P0] Sidebar + top-bar shell with workspace-aware nav groups
**对标自**: new-api `workspace-registry.ts` pattern — nav items grouped by workspace context (admin vs end-user)
**3api 现状**: 简易 sidebar，缺分组
**该做什么**: 重构 `ui/components/admin/Sidebar.tsx` — 分 4 group: 概览 (dashboard/stats) / 销售 (plans/orders/users) / 上游 (channels/wholesale) / 设置 (branding/payment-config/settings). Top bar 加 user menu + tenant 信息 + 主题 toggle.
**工程量估**: 8 hours
**为什么 P0**: 不重构 sidebar，任何 UI 新功能都没好的安置位置。

#### 3. [P0] shadcn/ui 12-component bootstrap
**对标自**: new-api 全量用 shadcn/ui (Button / Dialog / DropdownMenu / Toast / Card / Input / Select / Switch / Tabs / Table / Sheet / Tooltip)
**3api 现状**: 纯 Tailwind 自己写
**该做什么**: `npx shadcn@latest init` + 复制 12 个核心组件到 `ui/components/ui/` (MIT 许可，copy/paste 模式不引入 dep). Refactor 现有 Modal/Button/Input 使用 shadcn 实现.
**工程量估**: 4 hours
**为什么 P0**: 所有后续 UI 改造都需要这个底子；不做就是手搓每个组件。

#### 4. [P0] TanStack Table for users/orders/logs
**对标自**: new-api 用 TanStack Table v8（filter / sort / column-resize / virtualized rows）
**3api 现状**: 自己写 table + pagination
**该做什么**: `npm i @tanstack/react-table`. 替换 `/admin/users` + `/admin/orders` 表格. 加 column-toggle / multi-sort / 搜索 in-table.
**工程量估**: 6 hours
**为什么 P0**: 客诉中 "找用户难"的根因；admin 的核心日常操作。

#### 5. [P0] i18n zh + en (next-intl 或 next-i18next)
**对标自**: new-api 4 语 + sub2api 2 语
**3api 现状**: zh hardcoded
**该做什么**: `next-intl` setup + 提取所有 admin 字符串到 `messages/zh.json` + `messages/en.json`. Header 加语言切换. Storefront 也加（终端客户可能英文）.
**工程量估**: 8 hours
**为什么 P0**: GitHub launch 英文受众必需；中文圈外面找不到。

#### 6. [P0] 仪表盘 stat cards 升级
**对标自**: new-api 4-column stat grid with trend sparkline + delta arrow
**3api 现状**: 4 简易 StatCard
**该做什么**: 加 trend sparkline (recharts 小图) + 上涨/下跌箭头 + 同期对比 (vs prior 7d). 颜色保持单 brand-teal（**不要** sub2api 的彩虹卡片 — 见 Section 3）.
**工程量估**: 4 hours
**为什么 P0**: 仪表盘是 admin 看的第一眼，要有"在做生意"的感觉。

### P1 — v0.3 应做 (9 items)

#### 7. [P1] Cmd+K command palette
**对标自**: new-api `cmdk` integration — 全局快搜跳页 / 跑动作
**该做什么**: `npm i cmdk` + 注册 ~20 命令 (跳页 + 创套餐 + 发卡密 + 退款等). Ctrl+K 调起.
**工程量估**: 4 hours

#### 8. [P1] driver.js 新手引导
**对标自**: new-api 第一次登录的 step-by-step tour
**该做什么**: `npm i driver.js` + onboarding 完成后跑一次 highlighted tour (侧边栏 / 套餐 / 上游 / 财务 4 个 spot).
**工程量估**: 3 hours

#### 9. [P1] Dashboard auto-refresh + visibility-driven polling
**对标自**: new-api dashboard 30s 自动刷新（仅当 tab visible）
**该做什么**: TanStack Query + `refetchOnWindowFocus` + 30s interval gate by `document.visibilityState`. 适用 stat / 最近订单.
**工程量估**: 2 hours

#### 10. [P1] Quick toggle row (announcement / maintenance / signup-on)
**对标自**: sub2api admin top bar 三 toggle
**该做什么**: Admin top bar 加 3 toggle: 注册开放 / 维护模式 / 公告显示. 配 brand_config / system_setting 表.
**工程量估**: 4 hours

#### 11. [P1] 公开 pricing page
**对标自**: one-api `/pricing` model price table
**该做什么**: 我方有 plans CRUD，但缺一个公开 pricing 路由 `<slug>.3api.pro/pricing` 已存在。**新加** `3api.pro/pricing` 用于宣传 — 展示套餐 + 比较表 (跟 v0.1 comparison page 不同).
**工程量估**: 4 hours

#### 12. [P1] Skeleton loaders
**对标自**: new-api 全套 skeleton
**该做什么**: 加 shadcn `<Skeleton>` 到 stat cards / table / 详情页 loading states. 取代当前 "Loading..." 文字.
**工程量估**: 3 hours

#### 13. [P1] Table bulk-actions
**对标自**: new-api users/orders 表多选 + 批量
**该做什么**: TanStack Table row-selection + 批量 suspend / 批量 refund / 批量 export CSV.
**工程量估**: 4 hours

#### 14. [P1] Multi-key per channel
**对标自**: sub2api channel 可以挂多个 key + 自动 rotate
**该做什么**: channel 表加 keys JSONB array (currently single key). Rotate logic in upstream.ts. 现 v0.1 单 key 也保留兼容.
**工程量估**: 6 hours

#### 15. [P1] Daily check-in / sign-in
**对标自**: sub2api 每日签到送 token
**该做什么**: 终端用户 dashboard 加 check-in button + check-in log table + tenant 可配 "每日送 X token".
**工程量估**: 6 hours

### P2 — nice-to-have (8 items)

#### 16. [P2] Workspace switcher (一站长多店)
**对标自**: new-api workspace dropdown
**说明**: 一站长 owner 多个 tenant 时切换 — 不是 v0.1 用户痛点（一人一店为主），但 future-proof.
**工程量估**: 4 hours

#### 17. [P2] Channel scheduled health-check
**对标自**: new-api cron 每 5min ping channel
**说明**: 我方 wholesale 上游已 5min sync，BYOK channel 不在此循环. 加 per-channel health endpoint scan.
**工程量估**: 3 hours

#### 18. [P2] Affiliate program
**对标自**: one-api `AffCode` + `InviterId` 内置
**说明**: 站长邀站长。已在 P3 ROADMAP，提到 v0.2 没必要现在做.
**工程量估**: 8 hours

#### 19. [P2] OAuth as upstream identity import
**对标自**: sub2api 真 moat — Anthropic Console OAuth + Codex OAuth + Gemini OAuth 拉号池
**说明**: 接入 OAuth 流程拉客户的 Anthropic key 进自己上游 pool. 灰产边缘，慎重.
**工程量估**: 12+ hours
**风险**: 可能违反 Anthropic ToS — 需要法律评估.

#### 20. [P2] Per-plan USD limit + multi-currency
**对标自**: new-api channel.balance(USD)
**说明**: 我方 plans 是 CNY cents. 加 USD 价格 + currency 自动 detect (Accept-Language).
**工程量估**: 6 hours

#### 21. [P2] iframe-embed storefront widget
**对标自**: sub2api `embed.html`
**说明**: 站长在自己博客 iframe 嵌一个 "buy box". 我方 storefront 已可独立站, embed 是 nice-to-have.
**工程量估**: 4 hours

#### 22. [P2] Redemption (充值码) delete-by-name + batch ops
**对标自**: one-api redemption 表
**说明**: 我方 coupons 表存在但 admin UI 缺. 补 admin/coupons 页 + delete-by-name + batch generate.
**工程量估**: 4 hours

#### 23. [P2] User-to-user quota transfer
**对标自**: new-api 终端用户互转余额
**说明**: 团队/家庭账号共享场景. v0.1 不需要.
**工程量估**: 6 hours

## Section 3: Do NOT copy from competitors

**反学清单 — 避免误学**:

1. **one-api 倍率制 (group/model multiplier)** — 用户体验奇差，需要查表才知道真实计费. 我方坚持直接 cents 单价 + 月底 invoice PDF.
2. **sub2api 彩虹 stat-card icons** (蓝/紫/翠绿/琥珀) — 违反我方 `feedback_no_ai_gradient.md` 铁律. 单 brand-teal 保持品牌一致.
3. **VoAPI 闭源前端但 MIT shell 假开源** — 用户被诱导. 我方 100% MIT 真开源.
4. **Veloera 已死 fork** — 不要跟死项目对标. 砍掉.
5. **sub2api 通讯录/聊天功能** — 跟核心中转业务无关，膨胀代码. 我方守住 "API 中转 + 多租户" 核心.
6. **one-api 自定义 model_mapping 字符串语法**（`gpt-4:claude-3-5-sonnet`）— 容易拼错 + 无校验. 我方用 JSONB allowlist + per-plan model 配置.

## Section 4: Visual references

直接看 README + GitHub releases 截图（不下载）:
- new-api: github.com/QuantumNous/new-api/blob/main/README.md (中部多张 dashboard / channel / token 页截图)
- sub2api: github.com/Wei-Shaw/sub2api/blob/main/README.md (站点 demo 链接)
- one-api: github.com/songquanpeng/one-api/blob/main/README.en.md (设置页 / dashboard)

## Section 5: Recommended v0.2 6-week sprint plan

| Week | 任务 | 文件 | est hours |
|---|---|---|---|
| W1 | [P0 #3] shadcn/ui 12-component bootstrap | `ui/components/ui/*` (12 files) | 4 |
| W1 | [P0 #1] Light/dark theme switcher | `ui/components/ThemeProvider.tsx` + `ui/app/layout.tsx` + Tailwind config | 4-6 |
| W2 | [P0 #2] Sidebar + top-bar shell | `ui/components/admin/{Sidebar,TopBar}.tsx` + 重构 admin 各页 layout | 8 |
| W2 | [P0 #6] Stat cards 升级 | `ui/components/admin/StatCard.tsx` + recharts sparkline | 4 |
| W3 | [P0 #4] TanStack Table 改 users/orders | `ui/app/admin/{users,orders}/page.tsx` | 6 |
| W3 | [P0 #5] i18n zh + en | `messages/{zh,en}.json` + `ui/lib/i18n.ts` + 各页提取 | 8 |
| W4 | [P1 #7] Cmd+K palette | `ui/components/CommandPalette.tsx` | 4 |
| W4 | [P1 #9] Auto-refresh + visibility polling | `ui/lib/use-query.ts` (TanStack Query wrap) | 2 |
| W4 | [P1 #12] Skeleton loaders | shadcn `<Skeleton>` 应用各页 | 3 |
| W5 | [P1 #10] Quick toggle row | `ui/components/admin/TopToggles.tsx` | 4 |
| W5 | [P1 #11] Public pricing page | `ui/app/pricing/page.tsx` (root domain) | 4 |
| W5 | [P1 #13] Table bulk-actions | TanStack row-select + bulk handlers | 4 |
| W6 | [P1 #14] Multi-key per channel | `db/migrations/006-channel-multi-keys.sql` + `src/services/upstream.ts` | 6 |
| W6 | [P1 #8] driver.js 新手引导 | `ui/components/OnboardingTour.tsx` | 3 |
| W6 | [P1 #15] Daily check-in | `db/migrations/007-checkin.sql` + `src/routes/storefront/checkin.ts` + UI | 6 |

**Total**: 80 hours pessimistic, 60 hours optimistic. 6 weeks @ 10-13h/week is realistic for one engineer.

## Appendix A: stack note

new-api `default` theme stack = **React 19 + shadcn/ui + TanStack Router/Query/Table + recharts** — this is what 3api should converge toward. We're already on Next.js + Tailwind so the gap is just components.

Next.js 14 App Router 与 TanStack Router 不冲突（TanStack Router 用于子页面 client routing, App Router 用于 SSR/SSG 顶层）. 实际上我方目前用 Next App Router + Server Components 已经覆盖了路由 + data fetching，**不需要** TanStack Router. 只需要 TanStack Query + TanStack Table 即可.

## Appendix B: license check

- new-api: MIT ✓
- sub2api: 待 check (README 没明示)
- VoAPI: MIT shell only (binary 部分闭源)
- Veloera: MIT (但项目死了)
- shadcn/ui 组件: MIT 直接 copy/paste 允许 ✓
- TanStack Table/Query: MIT ✓
- driver.js: MIT ✓
- cmdk: MIT ✓
- next-intl: MIT ✓

**结论**: 所有要参考的 patterns + 库都是 MIT，3api 可以自由 inherit 设计 patterns 但不能 fork 代码 chunks.

## Appendix C: 我们当前真缺什么 (gap summary)

按 admin 视角：
1. ❌ 主题切换 → P0 #1
2. ❌ 国际化 → P0 #5
3. ⚠️ Sidebar 分组不清 → P0 #2
4. ⚠️ Table 没排序/过滤/批量 → P0 #4
5. ⚠️ Stat cards 太朴素 → P0 #6
6. ❌ 没共享 UI lib（每页手搓组件）→ P0 #3
7. ❌ 没快搜 → P1 #7
8. ❌ 没新手引导 → P1 #8
9. ❌ 没自动刷新 → P1 #9
10. ❌ 没顶部公告/维护 toggle → P1 #10

按终端用户视角：
1. ❌ 没每日签到 / 激励循环 → P1 #15
2. ❌ 没 pricing 公开页（只能登录看）→ P1 #11
3. ❌ 没 affiliate → P2 #18
