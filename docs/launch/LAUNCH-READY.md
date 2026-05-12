# Launch readiness — v0.8.0

What's done and what's left for the user before posting.

## Done (Claude shipped)

- v0.8.0 code on `main`, tag pushed to origin
- Container `3api-panel:v0.8.0` LIVE on 3api.pro tunnel
- CHANGELOG entries for every release v0.1.0 → v0.8.0
- `docs/launch/hn-show.md` refreshed with v0.8 numbers and 4 posts
  (HN / r/selfhosted / V2EX / Linux.do)
- `docs/SCREENSHOTS.md` documents zh/en capture loop
- Mobile-responsive verified (iPhone 14 fixtures in
  `docs/assets/mobile-audit-v2/`)
- All 41 pages prerender, OpenAPI 55 endpoints, i18n parity

## Left for the user (Claude cannot do)

1. **GitHub Release pages** — `gh release create v0.8.0 --notes-from-tag`
   per tag (or paste CHANGELOG sections by hand). Tags `v0.1.0` →
   `v0.8.0` already pushed; just need GitHub Release wrappers for the
   "Releases" tab to populate.
2. **Post to HackerNews** — submit `docs/launch/hn-show.md` HN section.
   Best time: weekday 7-9am PST.
3. **Post to r/selfhosted** — submit Reddit section. Mod queue is fast.
4. **Post to V2EX** — `分享创造` 板块, paste V2EX section.
5. **Post to Linux.do** — `开发调优` 板块, paste Linux.do section.
6. **Pin a "GitHub Stars Welcome" Discussion** — open one Discussion
   thread "v0.8.0 launch — feedback wanted" linking the 4 posts.
7. **Optional: Twitter/X post** — link to GitHub + screenshot from
   `docs/assets/screenshot-admin.png`. Tag `#opensource #claude #api`.

## Numbers you can quote

| Metric | Value |
|---|---|
| Static pages prerendered | 41 |
| Backend OpenAPI endpoints | 55 |
| i18n keys (zh+en, 100% parity) | 1209 |
| Upstream providers wired | 9 |
| DB migrations | 14 |
| Releases tagged | 8 (v0.1.0 → v0.8.0) |
| Image size | ~250 MB |
| Cold-start time | < 3s |

## Channels to avoid first wave

- Bilibili (visual platform, prep a screencast first)
- Xianyu (闲鱼) — direct competitor audience, may get reported
- WeChat groups — slow burn, save for after first feedback wave

## Risk callouts (no surprises)

- **HN moderators may down-rank** posts that read as commercial. We
  positioned 3API as "open-source bundled-upstream panel" not
  "platform reselling our service" — should pass.
- **Reddit r/selfhosted** wants self-host friendliness; the post leads
  with `docker compose up` + `install.sh`.
- **V2EX 分享创造** sometimes flags YAGNI/Chinese-only content; our
  post is bilingual-context, MIT, GitHub-linked — fits the section.

## After-launch checklist (rough)

1. Watch GitHub stars + issues — respond within 24h
2. Reply on every post within 2h of first hour
3. Drop a "Day 1 + Day 7" follow-up post if traction is real
4. If 50+ stars in week 1: open Discord/Slack for early adopters
