# Batch Operations — the fleet-management core

The single biggest pain of running many relay sites is repetition: update a channel, push an announcement, rotate an upstream key — and you do it 5, 10, N times, once per site, by hand. Batch operations turn every such change into one action across a selected set of sites.

Design invariant: **batch never invents its own write path.** Every mutation runs through the same single-site service method (`SitesService.*`, `applyGrant`), so each site automatically inherits access control (`canAccessSite` → 404), the read-only fuse (403), and audit. A batch is a fan-out with per-site results; one site failing never aborts the rest (partial success is the normal, reported outcome).

## Status legend
✅ shipped · 🚧 this iteration · ⬜ planned

---

## 1. Content & branding
- ✅ **Announcement** — set/clear the same announcement on N sites
- ✅ **Branding** — site name / logo / announcement across N sites
- ⬜ Per-site announcement templating (variables like `{siteName}`)

## 2. Channels (the highest-frequency need)
- ✅ **Create channel** — inject the same upstream channel into N sites
- ✅ **Enable / disable by name** — flip a named channel across N sites
- 🚧 **Update by name** — change baseUrl / apiKey / models / priority / weight for a named channel across N sites. **Key rotation** is the killer case: rotate one upstream key everywhere in a single action.
- 🚧 **Delete by name** — remove a named channel from N sites (destructive → confirm)
- 🚧 **Marketplace grant** — grant one channel template to N sites at once (BYO or managed)
- ⬜ **Marketplace revoke** — revoke a template's channel from N sites
- ⬜ **Test channels** — run a live test of a named channel across N sites, report which fail
- ⬜ Model-mapping / model-pricing bulk edits (where the engine supports it)

## 3. Visibility & drift detection
- 🚧 **Channel matrix** — one grid: rows = channel names, columns = sites, cell = enabled / disabled / absent. Instantly answers "which sites are missing channel X?" or "where is this key still enabled?" Click an absent cell to jump into creating it there.
- ⬜ **Model coverage matrix** — which models are served where
- ⬜ **Version/health rollup** — engine version + health + 24h usage/cost per site in one board (partially in Overview today)

## 4. Lifecycle (panel-provisioned sites only)
- 🚧 **Upgrade** — move N compose sites to a pinned version (enqueues one job per site; external sites reported as skipped)
- 🚧 **Start / Stop** — bulk power actions across N compose sites
- ⬜ **Backup** — trigger a backup across N sites

## 5. Users
- ⬜ **Disable / enable a user** across sites (e.g. an abuser present on several)
- ⬜ **Quota / balance** bulk adjustments

## 6. Targeting, safety & workflow
- ✅ Multi-select with read-only sites flagged and skipped
- ⬜ **Filter/select** sites by engine / group / tag / health
- ⬜ **Dry-run preview** — show exactly what each site will change before applying
- ⬜ **Retry failed** — re-run a batch against only the sites that failed
- ⬜ **Saved batches** — name and re-run a batch definition
- ⬜ **Scheduled batches** — cron a recurring batch (e.g. nightly announcement rotation)
- ⬜ Destructive-action confirmation (delete channel, stop sites)

---

## API surface

Write fan-out — `POST /api/sites/batch`, discriminated on `kind`:
```
{ slugs: string[], kind: "announcement", announcement }
{ slugs, kind: "branding", siteName?, logoUrl?, announcement? }
{ slugs, kind: "channel.create", channel: ChannelSpec }
{ slugs, kind: "channel.toggle", channelName, enabled }
{ slugs, kind: "channel.update", channelName, patch: { baseUrl?, apiKey?, models?, priority?, weight?, enabled? } }   // 🚧
{ slugs, kind: "channel.delete", channelName }                                                                        // 🚧
{ slugs, kind: "grant", templateKey, byo?, channelName?, groupIds?, priority? }                                       // 🚧
{ slugs, kind: "lifecycle", op: "upgrade"|"start"|"stop", toVersion? }                                                // 🚧
```
Response: `{ total, ok, failed, results: [{ slug, ok, detail?, error? }] }` — always HTTP 200; per-site outcomes carry the status.

Read — `GET /api/sites/channel-matrix` → `{ sites: [{slug,label}], channels: [{name, protocol, presence: { [slug]: "enabled"|"disabled"|"absent" }}] }`. 🚧

All batch writes are audited per site through the reused single-site methods; the batch layer adds no separate audit path.
