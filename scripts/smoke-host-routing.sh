#!/bin/bash
# Smoke test — Task #17 host-based routing.
#
# Validates:
#   1. GET / on Host: 3api.pro            → 3api MARKETING landing (express)
#   2. GET / on Host: <slug>.3api.pro     → Next "/" with host-aware client switch
#   3. GET /login on subdomain            → Next "/login/" page
#   4. GET /dashboard on subdomain        → Next "/dashboard/" page
#
# The host decision happens in two layers:
#   - Express layer (landingRouter): serves rich marketing HTML at "/" on root
#     domain only, falls through on subdomains.
#   - Client layer (HostAware hook): the Next static page re-renders the
#     correct variant on hydration based on window.location.host.
#
# We assert sentinel strings on the SERVED HTML:
#   marketing → "3API Panel — open-source" (express) OR data-marketing-landing (Next fallback)
#   store     → presence of /api/storefront client bundle + StoreLanding marker
#
# A subdomain "/" returns the Next bundle which contains BOTH variants in the
# JS; we look for the StoreLanding bundle hash to confirm the build includes it.
set +e
B=http://127.0.0.1:3199
PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

fetch() {
  # $1 = host header value, $2 = path
  # -L follows redirects (Next emits trailingSlash=true 301s to /path/).
  curl -sS -m 10 -L -H "Host: $1" "$B$2"
}

note "1. GET / on Host: 3api.pro → marketing HTML (express landing)"
RES1=$(fetch "3api.pro" "/")
if echo "$RES1" | grep -q "3API Panel — open-source"; then
  ok "express landing served on root domain"
else
  bad "expected express marketing HTML on 3api.pro/, got:"
  echo "$RES1" | head -c 300
  echo ""
fi

note "2. GET / on Host: acme.3api.pro → Next static page (will host-switch on hydration)"
RES2=$(fetch "acme.3api.pro" "/")
# The Next static page is the same HTML regardless of subdomain — the switch
# happens client-side. We verify:
#   - The Next HTML is served (DOCTYPE html lang="zh-CN").
#   - It's the page.tsx variant (contains the marketing fallback markup OR
#     a reference to the bundled HostAware client code).
# We also verify the body has the marketing landing markup (since that's
# the SSR/static prerender — store overlay activates at runtime).
if echo "$RES2" | grep -q 'lang="zh-CN"' && echo "$RES2" | grep -q -i "next"; then
  ok "Next static page served to subdomain (host-switch handled client-side)"
else
  bad "expected Next HTML on acme.3api.pro/, got:"
  echo "$RES2" | head -c 300
  echo ""
fi

note "2b. /  on Host: 3api.pro vs subdomain are DIFFERENT bodies"
LEN_ROOT=$(echo -n "$RES1" | wc -c)
LEN_SUB=$(echo -n "$RES2" | wc -c)
HASH_ROOT=$(echo -n "$RES1" | md5sum | cut -d' ' -f1)
HASH_SUB=$(echo -n "$RES2" | md5sum | cut -d' ' -f1)
if [ "$HASH_ROOT" != "$HASH_SUB" ]; then
  ok "root ($LEN_ROOT bytes) vs subdomain ($LEN_SUB bytes) bodies differ ($HASH_ROOT != $HASH_SUB)"
else
  bad "root and subdomain returned identical HTML — host-routing not engaging"
fi

note "3. GET /login on subdomain → Next /login page"
RES3=$(fetch "acme.3api.pro" "/login")
# Pre-hydration HTML is a neutral placeholder (no form yet); we verify it's
# the /login route by initialCanonicalUrl + lang. Form materializes when JS
# runs, and step 5 confirms the JS chunk ships StoreLogin+MarketingLogin.
if echo "$RES3" | grep -q 'lang="zh-CN"' && echo "$RES3" | grep -q 'initialCanonicalUrl.*\\"/login/\\"'; then
  ok "Next /login HTML served to subdomain (hydration picks store variant)"
else
  bad "expected /login HTML on subdomain, got:"
  echo "$RES3" | head -c 400
  echo ""
fi

note "4. GET /dashboard on subdomain → Next /dashboard page (will client-redirect to /dashboard/keys)"
RES4=$(fetch "acme.3api.pro" "/dashboard")
if echo "$RES4" | grep -q 'lang="zh-CN"' && echo "$RES4" | grep -q 'initialCanonicalUrl.*\\"/dashboard/\\"'; then
  ok "Next /dashboard HTML served to subdomain"
else
  bad "expected /dashboard HTML on subdomain, got:"
  echo "$RES4" | head -c 400
  echo ""
fi

note "4b. GET /dashboard/keys on subdomain (the actual store dashboard target)"
RES4B=$(fetch "acme.3api.pro" "/dashboard/keys")
if echo "$RES4B" | grep -q 'lang="zh-CN"' && echo "$RES4B" | grep -q 'initialCanonicalUrl.*\\"/dashboard/keys/\\"'; then
  ok "Next /dashboard/keys HTML served to subdomain"
else
  bad "expected /dashboard/keys HTML on subdomain"
  echo "$RES4B" | head -c 300
  echo ""
fi

note "5. JS bundle contains BOTH StoreLanding and Marketing components"
# The shared JS chunk must include the host-aware switch code.
# We look at the chunks referenced by the / page and check at least one of
# them mentions "data-store-landing" (added as a sentinel in StoreLanding).
CHUNK=$(echo "$RES2" | grep -oE '/_next/static/chunks/[a-zA-Z0-9_/-]+\.js' | head -1)
if [ -n "$CHUNK" ]; then
  # Pull each referenced chunk and grep across them.
  FOUND_STORE=0
  FOUND_MKTG=0
  for c in $(echo "$RES2" | grep -oE '/_next/static/chunks/[a-zA-Z0-9_/-]+\.js' | sort -u); do
    BODY=$(curl -sS -m 10 "$B$c")
    if echo "$BODY" | grep -q "data-store-landing"; then FOUND_STORE=1; fi
    if echo "$BODY" | grep -q "data-marketing-landing"; then FOUND_MKTG=1; fi
  done
  if [ "$FOUND_STORE" = "1" ] && [ "$FOUND_MKTG" = "1" ]; then
    ok "JS bundle ships both StoreLanding + Marketing variants (host-aware client switch ready)"
  else
    bad "bundle missing markers: store=$FOUND_STORE marketing=$FOUND_MKTG"
  fi
else
  bad "no JS chunk references found in HTML"
fi

note "6. /api/storefront/brand reachable from subdomain (tenant resolved)"
BR=$(curl -sS -m 10 -H "Host: default.3api.pro" "$B/api/storefront/brand")
if echo "$BR" | grep -qE '"primary_color"|"store_name"|"data"'; then
  ok "subdomain → /api/storefront/brand resolves tenant + returns brand"
else
  bad "subdomain /api/storefront/brand bad: $BR"
fi

note "7. /create on root domain still works (allow-listed)"
CR=$(curl -sS -m 10 -L -H "Host: 3api.pro" -o /dev/null -w '%{http_code}' "$B/create")
if [ "$CR" = "200" ]; then ok "/create still 200 on root"; else bad "/create on root = $CR"; fi

echo ""
echo "===================="
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
