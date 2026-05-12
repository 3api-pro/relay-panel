#!/bin/bash
# Smoke test — admin lives on the root domain.
#
# Validates the user-reported bug fix: a freshly signed-up reseller can log
# into 3api.pro/admin (root domain) directly, without being kicked to a
# tenant subdomain. Subdomains are storefronts only.
#
# Checks:
#   1. POST /api/signup-tenant on Host: 3api.pro      → 201 + Set-Cookie + redirect_to:/admin + NO login_url
#   2. GET  /api/admin/me with that cookie            → 200 with admin+tenant+brand
#   3. GET  /api/admin/me with NO cookie/token        → 401
#   4. POST /api/admin/login (email+password)         → 200, sets fresh cookie, returns tenant slug
#   5. POST /api/admin/login with wrong password      → 401
#   6. Wrong-tenant access on subdomain returns 403   → admin from tenant A cannot use tenant B's subdomain
#   7. GET  /admin on Host: <slug>.3api.pro            → store sees a host-switch page (HTML still served by Next)
#   8. GET  /admin on Host: 3api.pro                   → 200 (Next admin login page)
#   9. /api/v1 + /api/storefront 404 on root domain   → requireTenantHost guard
#
# Requires: 3api-panel on :3199, TENANT_MODE=multi, SAAS_DOMAIN=3api.pro, TENANT_SELF_SIGNUP=on.
set +e
B=http://127.0.0.1:3199
PG="psql -q -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

ROOT_HDR="Host: 3api.pro"

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Wait for rate limit to clear (1 signup / 60s).
# We use 2 distinct IPs implicitly via DB cleanup, but the limiter is in-process.
# So we just clear old smoke users first and accept the 60s window.

EMAIL="root-login-smoke-$(date +%s%N)@example.com"
PW="smoke-pw-12345"

# 1. signup-tenant on root host
note "1. POST /api/signup-tenant on Host: 3api.pro"
SU_OUT=$(curl -sS -m 10 -i -H "$ROOT_HDR" -H 'Content-Type: application/json' \
  -X POST -d "{\"admin_email\":\"$EMAIL\",\"admin_password\":\"$PW\"}" \
  "$B/api/signup-tenant" )
HTTP=$(echo "$SU_OUT" | grep -E '^HTTP/' | tail -1 | awk '{print $2}')
COOKIE=$(echo "$SU_OUT" | grep -i '^set-cookie:' | grep -i '3api_admin_token' | head -1 | sed 's/^[Ss]et-[Cc]ookie:\s*//' | sed 's/;.*$//')
BODY=$(echo "$SU_OUT" | awk 'BEGIN{b=0} /^\r?$/{b=1; next} b{print}')
SLUG=$(echo "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tenant",{}).get("slug",""))' 2>/dev/null)
REDIR=$(echo "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("redirect_to",""))' 2>/dev/null)
LOGIN_URL=$(echo "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("login_url",""))' 2>/dev/null)
TOKEN=$(echo "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ "$HTTP" = "201" ] && [ -n "$COOKIE" ] && [ "$REDIR" = "/admin" ] && [ -z "$LOGIN_URL" ] && [ -n "$SLUG" ] && [ -n "$TOKEN" ]; then
  ok "signup HTTP=$HTTP slug=$SLUG cookie set redirect_to=/admin token issued no login_url"
else
  bad "signup unexpected: HTTP=$HTTP slug=$SLUG redir=$REDIR cookie='$COOKIE' login_url='$LOGIN_URL' body=$(echo "$BODY" | head -c 300)"
  exit 1
fi

# 2. /api/admin/me with cookie
note "2. GET /api/admin/me with cookie"
ME=$(curl -sS -m 10 -H "$ROOT_HDR" --cookie "$COOKIE" "$B/api/admin/me")
ME_EMAIL=$(echo "$ME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("admin",{}).get("email",""))' 2>/dev/null)
ME_SLUG=$(echo "$ME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tenant",{}).get("slug",""))' 2>/dev/null)
if [ "$ME_EMAIL" = "$EMAIL" ] && [ "$ME_SLUG" = "$SLUG" ]; then
  ok "/admin/me with cookie returns $ME_EMAIL @ $ME_SLUG"
else
  bad "/admin/me with cookie bad: email=$ME_EMAIL slug=$ME_SLUG resp=$ME"
fi

# 2b. /api/admin/me with Bearer (token from signup response)
note "2b. GET /api/admin/me with Bearer (token from signup)"
ME2=$(curl -sS -m 10 -H "$ROOT_HDR" -H "Authorization: Bearer $TOKEN" "$B/api/admin/me")
ME2_EMAIL=$(echo "$ME2" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("admin",{}).get("email",""))' 2>/dev/null)
if [ "$ME2_EMAIL" = "$EMAIL" ]; then ok "/admin/me with Bearer works"; else bad "/admin/me Bearer bad: $ME2"; fi

# 3. /api/admin/me with NO auth
note "3. GET /api/admin/me with no auth → 401"
HTTP3=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "$ROOT_HDR" "$B/api/admin/me")
if [ "$HTTP3" = "401" ]; then ok "401 with no auth"; else bad "expected 401, got $HTTP3"; fi

# 4. POST /api/admin/login on root domain
note "4. POST /api/admin/login on root domain (email+password)"
LOG_OUT=$(curl -sS -m 10 -i -H "$ROOT_HDR" -H 'Content-Type: application/json' \
  -X POST -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" \
  "$B/api/admin/login")
HTTP4=$(echo "$LOG_OUT" | grep -E '^HTTP/' | tail -1 | awk '{print $2}')
COOKIE2=$(echo "$LOG_OUT" | grep -i '^set-cookie:' | grep -i '3api_admin_token' | head -1 | sed 's/^[Ss]et-[Cc]ookie:\s*//' | sed 's/;.*$//')
BODY4=$(echo "$LOG_OUT" | awk 'BEGIN{b=0} /^\r?$/{b=1; next} b{print}')
LOG_SLUG=$(echo "$BODY4" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tenant",{}).get("slug",""))' 2>/dev/null)
LOG_TOK=$(echo "$BODY4" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ "$HTTP4" = "200" ] && [ -n "$COOKIE2" ] && [ "$LOG_SLUG" = "$SLUG" ] && [ -n "$LOG_TOK" ]; then
  ok "/admin/login on root: HTTP=$HTTP4 slug=$LOG_SLUG cookie set token issued"
else
  bad "/admin/login on root unexpected: HTTP=$HTTP4 slug=$LOG_SLUG cookie='$COOKIE2' body=$(echo "$BODY4" | head -c 300)"
fi

# 5. /api/admin/login wrong password
note "5. POST /api/admin/login wrong password → 401"
HTTP5=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "$ROOT_HDR" -H 'Content-Type: application/json' \
  -X POST -d "{\"email\":\"$EMAIL\",\"password\":\"wrong-pw\"}" "$B/api/admin/login")
if [ "$HTTP5" = "401" ]; then ok "wrong password rejected 401"; else bad "expected 401, got $HTTP5"; fi

# 6. Same admin tries to use a DIFFERENT tenant subdomain
note "6. Admin from tenant A on tenant B's subdomain → 403"
OTHER_SLUG=$($PG -t -A -c "SELECT slug FROM tenant WHERE slug != '$SLUG' AND status='active' ORDER BY id LIMIT 1;" | tr -d ' \r\n')
if [ -n "$OTHER_SLUG" ]; then
  HTTP6=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Host: ${OTHER_SLUG}.3api.pro" -H "Authorization: Bearer $TOKEN" "$B/api/admin/me")
  if [ "$HTTP6" = "403" ]; then ok "cross-tenant blocked 403 (admin slug=$SLUG → other slug=$OTHER_SLUG)"; else bad "expected 403, got $HTTP6"; fi
else
  echo "  SKIP: no other tenant to cross-check"
fi

# 7. GET /admin on subdomain (Next page served, host-switch banner on client)
note "7. GET /admin/login/ on Host: ${SLUG}.3api.pro → Next page served"
HTTP7=$(curl -sS -m 10 -L -o /dev/null -w '%{http_code}' -H "Host: ${SLUG}.3api.pro" "$B/admin/login")
RES7=$(curl -sS -m 10 -L -H "Host: ${SLUG}.3api.pro" "$B/admin/login")
if [ "$HTTP7" = "200" ] && echo "$RES7" | grep -q 'lang="zh-CN"'; then
  ok "/admin/login on subdomain serves Next page (host-aware client banner)"
else
  bad "expected 200 HTML, got $HTTP7"
fi

# 8. GET /admin on root domain (Next page served)
note "8. GET /admin/login/ on Host: 3api.pro → Next page served"
HTTP8=$(curl -sS -m 10 -L -o /dev/null -w '%{http_code}' -H "$ROOT_HDR" "$B/admin/login")
if [ "$HTTP8" = "200" ]; then ok "/admin/login on root 200"; else bad "expected 200, got $HTTP8"; fi

# 9. /api/v1 + /api/storefront 404 on root (requireTenantHost)
note "9. /api/v1/* and /api/storefront/* on root → 404 (requireTenantHost)"
HTTP9A=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "$ROOT_HDR" "$B/api/v1/messages")
HTTP9B=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "$ROOT_HDR" "$B/api/storefront/plans")
if [ "$HTTP9A" = "404" ] && [ "$HTTP9B" = "404" ]; then
  ok "v1=$HTTP9A storefront=$HTTP9B both 404 on root domain"
else
  bad "expected both 404 on root: v1=$HTTP9A storefront=$HTTP9B"
fi

# Cleanup: drop the smoke tenant + admin (cascade)
$PG -c "DELETE FROM reseller_admin WHERE email='$EMAIL';" >/dev/null 2>&1
TID=$($PG -t -A -c "SELECT id FROM tenant WHERE slug='$SLUG';" | tr -d ' \r\n')
if [ -n "$TID" ]; then
  $PG -c "DELETE FROM plans WHERE tenant_id=$TID;" >/dev/null 2>&1
  $PG -c "DELETE FROM brand_config WHERE tenant_id=$TID;" >/dev/null 2>&1
  $PG -c "DELETE FROM wholesale_balance WHERE tenant_id=$TID;" >/dev/null 2>&1
  $PG -c "DELETE FROM tenant WHERE id=$TID;" >/dev/null 2>&1
fi

echo ""
echo "===================="
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
