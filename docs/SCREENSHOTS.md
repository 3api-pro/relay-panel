# Regenerating the README screenshots

Ten PNGs under `docs/assets/screenshot-*.png` are captured by
`scripts/screenshot.ts` against a live panel container — five frames
each in **zh** (default, no suffix) and **en** (`-en` suffix). They are
**not** committed by hand. To refresh after a UI change:

```bash
# 1. make sure the panel container is up and healthy
docker ps --filter name=3api-panel        # expect Status: Up ... (healthy)
curl -fsS http://localhost:3199/health    # expect {"ok":true,...}

# 2. install the playwright browser once (skip if already there)
cd /path/to/3api-relay-panel
npm install                                # picks up playwright from devDeps
npx playwright install chromium            # ~110 MB download (use HTTPS_PROXY if needed)

# 3. (Ubuntu only) install chromium runtime deps + CJK fonts once
sudo apt-get install -y libnss3 libnspr4 libasound2t64 libdbus-1-3 \
                        libxkbcommon0 libxcomposite1 libxdamage1 \
                        libxfixes3 libxrandr2 libgbm1 libatk1.0-0 \
                        libatk-bridge2.0-0 libcups2 libxshmfence1 \
                        fonts-noto-cjk fonts-noto-color-emoji

# 4. run the wrapper — it seeds a `demo` tenant and end-user (idempotent)
#    then drives playwright through 5 frames × N locales (zh + en by default).
npm run screenshots
# (equivalent to: bash scripts/run-screenshots.sh)

# To capture only one locale:
SCREENSHOT_LOCALES=zh npm run screenshots
SCREENSHOT_LOCALES=en npm run screenshots

# 5. commit the PNGs (the glob picks up both zh and en variants)
git add docs/assets/screenshot-*.png
git commit -m "docs: refresh screenshots"
```

## How it works

The wrapper:

1. Checks `http://localhost:3199/health`.
2. Reads `PLATFORM_TOKEN` from the running `3api-panel` container env if
   the env var isn't already set in your shell.
3. Calls `POST /api/platform/tenants` to create the `demo` tenant
   (idempotent — already-exists is treated as success).
4. Force-resets the admin password to a known value via direct SQL so the
   script can re-run across previous seedings with different credentials.
5. Logs in as the admin and grabs both the JWT and HttpOnly cookie.
6. Tops up `wholesale_balance` (so the admin dashboard's *Upstream balance*
   card shows a non-zero value).
7. Signs up (or re-uses) an end-user and gives them quota.
8. Hands the two JWTs to `scripts/screenshot.ts` via env vars.

`scripts/screenshot.ts` launches headless chromium with
`--host-resolver-rules` so `3api.pro` and `demo.3api.pro` both resolve to
`127.0.0.1:$PORT`. This lets the URL bar carry the real domain (so the
panel's tenant-resolver and root-domain landing router dispatch correctly)
while every request actually hits the local container.

Five frames are captured **per locale**. For each locale in
`SCREENSHOT_LOCALES` (default `zh,en`), playwright sets a `3api_locale`
cookie on both the root host and the tenant host, then re-shoots all
five frames. The `zh` locale writes the canonical filename; every other
locale appends `-<locale>` before `.png`.

| Frame | URL (after host-resolver rewrites) | Auth | `zh` filename | `en` filename |
|---|---|---|---|---|
| Landing | `http://3api.pro:3199/` | none | `screenshot-landing.png` | `screenshot-landing-en.png` |
| Storefront | `http://demo.3api.pro:3199/` | none | `screenshot-storefront.png` | `screenshot-storefront-en.png` |
| Onboarding | `http://demo.3api.pro:3199/admin/onboarding/1/` | admin cookie + localStorage `token` | `screenshot-onboarding.png` | `screenshot-onboarding-en.png` |
| Admin | `http://demo.3api.pro:3199/admin/` | admin cookie + localStorage `token` | `screenshot-admin.png` | `screenshot-admin-en.png` |
| User | `http://demo.3api.pro:3199/dashboard/` | localStorage `sf_token` | `screenshot-user.png` | `screenshot-user-en.png` |

## Tweakable knobs

All of these are env vars (see `scripts/run-screenshots.sh` for defaults):

- `PANEL_URL` — default `http://localhost:3199`
- `ROOT_HOST` — default `3api.pro`
- `TENANT_SLUG` / `TENANT_HOST` — default `demo` / `demo.3api.pro`
- `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD`
- `DEMO_ENDUSER_EMAIL` / `DEMO_ENDUSER_PASSWORD`
- `POSTGRES_CONTAINER` / `POSTGRES_DB` / `POSTGRES_USER`
- `SCREENSHOT_OUT_DIR` — defaults to `docs/assets`
- `SCREENSHOT_LOCALES` — comma-separated, default `zh,en`. The first
  locale that happens to be `zh` writes the canonical filename; every
  other locale appends `-<locale>` (so adding `ja` would emit a third
  set under `screenshot-*-ja.png`).

## Troubleshooting

**Playwright can't download chromium (firewalled / GFW):**
Use a HTTPS proxy when running `npx playwright install`:

```bash
HTTPS_PROXY=http://your-proxy:port npx playwright install chromium
```

The npmmirror fallback (`PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`)
is missing some recent versions, so a real proxy is usually the right answer.

**Screenshots show tofu boxes for CJK text:**
Install `fonts-noto-cjk` and re-run; fontconfig auto-detects it.

**Admin login fails with 401 "Invalid credentials":**
The wrapper now resets the admin password each run via SQL, so this should
be self-healing. If you see it anyway, check that `DEMO_ADMIN_EMAIL` matches
the email actually stored in `reseller_admin`. The wrapper auto-discovers
the existing admin email if it differs.
