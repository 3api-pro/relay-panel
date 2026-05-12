/**
 * Playwright-driven screenshot capture for docs/assets.
 *
 * Drives headless chromium against the live panel container on
 * SCREENSHOT_BASE_URL (default http://localhost:3199) with carefully
 * spoofed Host headers so we hit both the root-domain SSR landing
 * page and the per-tenant Next.js storefront/admin app from a single
 * server binary.
 *
 * Five frames:
 *   1. screenshot-landing.png      root domain — marketing hero
 *   2. screenshot-onboarding.png   admin onboarding step 1 (recommended vs BYOK)
 *   3. screenshot-storefront.png   tenant storefront landing
 *   4. screenshot-admin.png        admin dashboard (sparklines + recent orders)
 *   5. screenshot-user.png         end-user dashboard (balance + check-in)
 *
 * The wrapper script scripts/run-screenshots.sh seeds a `demo` tenant
 * via /platform/tenants (idempotent), creates an end-user, and passes
 * the resulting JWTs through environment variables. We inject both
 * the HttpOnly admin cookie AND the localStorage entries that the
 * Next.js client code reads for authenticated fetches.
 */
import { chromium, BrowserContext, Page } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE = (process.env.SCREENSHOT_BASE_URL || 'http://localhost:3199').replace(/\/$/, '');
const OUT = process.env.SCREENSHOT_OUT_DIR || '/root/3api-relay-panel/docs/assets';
const ROOT_HOST = process.env.SCREENSHOT_ROOT_HOST || '3api.pro';
const TENANT_HOST = process.env.SCREENSHOT_TENANT_HOST || 'demo.3api.pro';
const ADMIN_JWT = process.env.DEMO_ADMIN_JWT || '';
const ENDUSER_JWT = process.env.DEMO_ENDUSER_JWT || '';
const VIEWPORT = {
  width: parseInt(process.env.SCREENSHOT_VIEWPORT_WIDTH || '1280', 10),
  height: parseInt(process.env.SCREENSHOT_VIEWPORT_HEIGHT || '800', 10),
};
const IS_MOBILE = process.env.SCREENSHOT_IS_MOBILE === '1';
const DEVICE_SCALE = parseFloat(process.env.SCREENSHOT_DEVICE_SCALE || (IS_MOBILE ? '2' : '1'));
const CONTEXT_EXTRA: Record<string, any> = IS_MOBILE
  ? { isMobile: true, deviceScaleFactor: DEVICE_SCALE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
  : { deviceScaleFactor: DEVICE_SCALE };
const LOCALES = (process.env.SCREENSHOT_LOCALES || 'zh,en').split(',').map(x => x.trim()).filter(Boolean);
const RENDER_WAIT_MS = 2000;

// Chromium will resolve ROOT_HOST and TENANT_HOST itself if we pass
// --host-resolver-rules; that way the URL keeps the real domain (and the
// browser sends the correct Host header), while every DNS lookup resolves
// to the local panel address.
const BASE_URL = new URL(BASE);
const BASE_PORT = BASE_URL.port || (BASE_URL.protocol === 'https:' ? '443' : '80');
const BASE_TARGET = `127.0.0.1:${BASE_PORT}`;
const HOST_RESOLVER_RULES =
  `MAP ${ROOT_HOST} ${BASE_TARGET}, ` +
  `MAP ${TENANT_HOST} ${BASE_TARGET}, ` +
  `MAP www.${ROOT_HOST} ${BASE_TARGET}`;

const ROOT_BASE_URL = `${BASE_URL.protocol}//${ROOT_HOST}:${BASE_PORT}`;
const TENANT_BASE_URL = `${BASE_URL.protocol}//${TENANT_HOST}:${BASE_PORT}`;

async function navigateAndShot(
  page: Page,
  fullUrl: string,
  filename: string,
  opts: { waitFor?: string; extraWaitMs?: number } = {},
): Promise<void> {
  console.log(`  → ${fullUrl}`);
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // networkidle is often false on SSR-with-streaming-JS pages; use a
  // bounded networkidle + explicit wait for hydration to settle.
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 });
  } catch {
    /* tolerate slow long-poll endpoints; we'll still capture */
  }
  if (opts.waitFor) {
    try {
      await page.waitForSelector(opts.waitFor, { timeout: 5_000 });
    } catch {
      /* selector optional; keep going */
    }
  }
  await page.waitForTimeout(opts.extraWaitMs ?? RENDER_WAIT_MS);
  const out = path.join(OUT, filename);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`  ✓ ${filename}`);
}

async function seedStorefrontLocalStorage(ctx: BrowserContext, token: string): Promise<void> {
  // Next.js storefront reads localStorage.sf_token (lib/store-api.ts).
  await ctx.addInitScript(
    ({ token }) => {
      try {
        window.localStorage.setItem('sf_token', token);
      } catch {
        /* ignore */
      }
    },
    { token },
  );
}

async function seedAdminLocalStorage(ctx: BrowserContext, token: string): Promise<void> {
  // Next.js admin reads localStorage.token (lib/api.ts) for client fetches.
  // The HttpOnly cookie is set separately for SSR.
  await ctx.addInitScript(
    ({ token }) => {
      try {
        window.localStorage.setItem('token', token);
        window.localStorage.setItem('onboarding_done', '0');
        window.localStorage.setItem('onboarding_step', '1');
      } catch {
        /* ignore */
      }
    },
    { token },
  );
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  console.log(`[screenshot] base=${BASE} out=${OUT}`);
  console.log(`[screenshot] root host=${ROOT_HOST}  tenant host=${TENANT_HOST}`);

  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
    ],
  });

  try {
    for (const __locale of LOCALES) {
      const localeSuffix = __locale === 'zh' ? '' : `-${__locale}`;
      console.log(`[screenshot] locale=${__locale} (suffix='${localeSuffix}')`);
    // ─────────────────────────────────────────────────────────────
    // Frame 1: Marketing landing (root domain SSR)
    // ─────────────────────────────────────────────────────────────
    {
      const ctx = await browser.newContext({ viewport: VIEWPORT, ...CONTEXT_EXTRA });
      await ctx.addCookies([
        { name: '3api_locale', value: __locale, domain: ROOT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
        { name: '3api_locale', value: __locale, domain: TENANT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
      ]);
      const page = await ctx.newPage();
      await navigateAndShot(page, `${ROOT_BASE_URL}/`, `screenshot-landing${localeSuffix}.png`);
      await ctx.close();
    }

    // ─────────────────────────────────────────────────────────────
    // Frame 3 (storefront landing, unauth) — done early since it
    // is the public state and doesn't need cookies.
    // ─────────────────────────────────────────────────────────────
    {
      const ctx = await browser.newContext({ viewport: VIEWPORT, ...CONTEXT_EXTRA });
      await ctx.addCookies([
        { name: '3api_locale', value: __locale, domain: ROOT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
        { name: '3api_locale', value: __locale, domain: TENANT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
      ]);
      const page = await ctx.newPage();
      await navigateAndShot(page, `${TENANT_BASE_URL}/`, `screenshot-storefront${localeSuffix}.png`);
      await ctx.close();
    }

    // ─────────────────────────────────────────────────────────────
    // Frames 2 + 4: Admin onboarding + dashboard
    // Cookie scope is the IP literal because we proxy Host header
    // separately; Playwright keys cookies by URL host. We attach by
    // host=localhost (or whatever BASE provides) so they apply to
    // every request the browser makes.
    // ─────────────────────────────────────────────────────────────
    if (ADMIN_JWT) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, ...CONTEXT_EXTRA });
      await ctx.addCookies([
        { name: '3api_locale', value: __locale, domain: ROOT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
        { name: '3api_locale', value: __locale, domain: TENANT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
      ]);
      await ctx.addCookies([
        {
          name: '3api_admin_token',
          value: ADMIN_JWT,
          url: TENANT_BASE_URL,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      await seedAdminLocalStorage(ctx, ADMIN_JWT);
      const page = await ctx.newPage();
      await navigateAndShot(
        page,
        `${TENANT_BASE_URL}/admin/onboarding/1/`,
        `screenshot-onboarding${localeSuffix}.png`,
        { waitFor: 'main', extraWaitMs: 2500 },
      );
      await navigateAndShot(
        page,
        `${TENANT_BASE_URL}/admin/`,
        `screenshot-admin${localeSuffix}.png`,
        { waitFor: 'main', extraWaitMs: 2500 },
      );
      await ctx.close();
    } else {
      console.log('  ⚠ DEMO_ADMIN_JWT empty — skipping onboarding/admin frames');
    }

    // ─────────────────────────────────────────────────────────────
    // Frame 5: End-user dashboard
    // ─────────────────────────────────────────────────────────────
    if (ENDUSER_JWT) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, ...CONTEXT_EXTRA });
      await ctx.addCookies([
        { name: '3api_locale', value: __locale, domain: ROOT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
        { name: '3api_locale', value: __locale, domain: TENANT_HOST, path: '/', expires: Math.floor(Date.now()/1000) + 3600 },
      ]);
      await seedStorefrontLocalStorage(ctx, ENDUSER_JWT);
      const page = await ctx.newPage();
      await navigateAndShot(
        page,
        `${TENANT_BASE_URL}/dashboard/`,
        `screenshot-user${localeSuffix}.png`,
        { waitFor: 'main', extraWaitMs: 2500 },
      );
      await ctx.close();
    } else {
      console.log('  ⚠ DEMO_ENDUSER_JWT empty — skipping end-user frame');
    }
    }
  } finally {
    await browser.close();
  }

  console.log(`[screenshot] done → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
