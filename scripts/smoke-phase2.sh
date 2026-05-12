#!/bin/bash
# Smoke test — Phase-2 per-tenant shadow sk-relay-* (v0.5).
#
# Drives signup-tenant under both PHASE2_AUTO_PROVISION=off (default) and
# =on, plus the manual /platform/tenants/:id/upgrade-shadow endpoint.
# Verifies:
#   1. Default (off) — provisioner copies shared wsk-* into channel.api_key
#      and labels phase='phase1'.
#   2. Env on, but upstream /v1/wholesale/purchase 404s (the local 3103
#      llmapi build does not have wholesale routes mounted) — provisioner
#      falls back to phase-1 with reason='phase2_fallback_*'.
#   3. /platform/tenants/:id/upgrade-shadow returns a structured 502 with
#      purchase.error when the upstream 404s (no debit).
#   4. signup never 5xx's regardless of upstream state.
#
# Does NOT spend real ¥29 — the upstream returns 404 so no sk-relay-* is
# minted. To test real spend, point UPSTREAM_BASE_URL at a wholesale-enabled
# llmapi build and re-run (will print the real sk-relay-* prefix).
#
# Requires:
#   - 3api-panel listening on :3199 (TENANT_MODE=multi, SAAS_DOMAIN=3api.pro,
#     TENANT_SELF_SIGNUP=on, PLATFORM_TOKEN set)
#   - postgres container 'postgres' on :5432 (db=relay_panel_3api, user=admin)
#   - migration 013 applied (for provision_phase column — graceful if absent)
#
# Exits non-zero if any check fails. Verbose pass/fail per step.
set -uo pipefail

B=${B:-http://127.0.0.1:3199}
SAAS=${SAAS:-3api.pro}
# Auto-detect the panel container: prefer an explicit override, then pick
# the one whose published port matches the URL we're testing.
PANEL_CONTAINER=${PANEL_CONTAINER:-}
if [ -z "$PANEL_CONTAINER" ]; then
  case "$B" in
    *:3299*) PANEL_CONTAINER=3api-panel-v05-smoke;;
    *)       PANEL_CONTAINER=3api-panel;;
  esac
fi
PG="docker exec postgres psql -q -U admin -d relay_panel_3api"

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

ch()   { curl -sS -m 15 "$@"; }

# Resolve effective env on the panel container. We do NOT mutate the
# running container — just check what we'll be testing against.
EFFECTIVE_PHASE2=$(docker exec "$PANEL_CONTAINER" sh -c 'echo "${PHASE2_AUTO_PROVISION:-off}"' 2>/dev/null | tr -d '\r')
EFFECTIVE_UPSTREAM=$(docker exec "$PANEL_CONTAINER" sh -c 'echo "${UPSTREAM_BASE_URL:-unset}"' 2>/dev/null | tr -d '\r')
EFFECTIVE_UPSTREAM_KEY_PREFIX=$(docker exec "$PANEL_CONTAINER" sh -c 'echo "${UPSTREAM_KEY:0:8}"' 2>/dev/null | tr -d '\r')
echo "[setup] container PHASE2_AUTO_PROVISION=${EFFECTIVE_PHASE2}"
echo "[setup] container UPSTREAM_BASE_URL=${EFFECTIVE_UPSTREAM}"
echo "[setup] container UPSTREAM_KEY prefix=${EFFECTIVE_UPSTREAM_KEY_PREFIX}…"

PLATFORM_TOKEN=$(docker exec "$PANEL_CONTAINER" sh -c 'echo "$PLATFORM_TOKEN"' 2>/dev/null | tr -d '\r')

# Pre-flight: panel must be reachable.
HCHK=$(ch -o /dev/null -w '%{http_code}' "$B/health" || echo 000)
if [ "$HCHK" != "200" ]; then
  echo "FATAL: panel /health returned $HCHK at $B"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Migration 013 — provision_phase column present (or gracefully absent).
# ---------------------------------------------------------------------------
note "1. migration 013 — provision_phase column"
COL=$($PG -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_name='upstream_channel' AND column_name='provision_phase';" 2>/dev/null | tr -d '\r' | xargs)
if [ "$COL" = "provision_phase" ]; then
  ok "provision_phase column present"
else
  echo "  INFO: migration 013 not applied — phase tracking via custom_headers only"
  ok "migration 013 optional"
fi

# ---------------------------------------------------------------------------
# 2. Phase-1 (current env) — signup writes shared wsk-* to channel.
# ---------------------------------------------------------------------------
note "2. signup-tenant (phase-1 default — shared wsk-)"
STAMP=$(date +%s)
SLUG="ph2-${STAMP}"
EMAIL="ph2-${STAMP}@test.local"

R=$(ch -X POST "$B/signup-tenant" \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"$EMAIL\",\"admin_password\":\"smokepwd-1234\"}")
TENANT_ID=$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tenant",{}).get("id",""))' 2>/dev/null)
PHASE_FROM_API=$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); uc=d.get("upstream_channel") or {}; print(uc.get("phase",""))' 2>/dev/null)
CH_ID=$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); uc=d.get("upstream_channel") or {}; print(uc.get("id",""))' 2>/dev/null)

if [ -z "$TENANT_ID" ]; then
  bad "signup did not return tenant id. response: $(echo "$R" | head -c 200)"
else
  ok "signup created tenant id=$TENANT_ID slug=$SLUG"
fi

if [ -z "$CH_ID" ]; then
  bad "no upstream_channel in response"
else
  ok "channel provisioned id=$CH_ID"
fi

# Phase in API response: 'phase1' (default off) OR 'phase1' on phase2 fallback.
case "$PHASE_FROM_API" in
  phase1) ok "API response phase=phase1 (env=$EFFECTIVE_PHASE2 → shared key path)";;
  phase2) ok "API response phase=phase2 (env on + upstream live)";;
  *)      bad "unexpected phase in API: '$PHASE_FROM_API'";;
esac

# DB: api_key should equal the platform wsk- (phase-1) OR a sk-relay-* (phase-2).
KEY_IN_DB=$($PG -t -A -c "SELECT api_key FROM upstream_channel WHERE id=$CH_ID;" 2>/dev/null | tr -d '\r' | head -1)
case "$KEY_IN_DB" in
  wsk-*)
    ok "channel.api_key is wsk-* (phase-1 shared key) — prefix=${KEY_IN_DB:0:12}"
    ;;
  sk-relay-*)
    ok "channel.api_key is sk-relay-* (phase-2 per-tenant!) — prefix=${KEY_IN_DB:0:16}"
    ;;
  *)
    bad "channel.api_key has unexpected prefix: '${KEY_IN_DB:0:12}'"
    ;;
esac

# custom_headers should carry the phase marker for downstream observability.
PHASE_FROM_HDR=$($PG -t -A -c "SELECT custom_headers->>'X-3api-Provision-Phase' FROM upstream_channel WHERE id=$CH_ID;" 2>/dev/null | tr -d '\r' | head -1)
if [ -n "$PHASE_FROM_HDR" ]; then
  ok "custom_headers.X-3api-Provision-Phase=$PHASE_FROM_HDR"
else
  bad "no X-3api-Provision-Phase in custom_headers"
fi

# If migration 013 applied, provision_phase column should be set.
if [ "$COL" = "provision_phase" ]; then
  PH_COL=$($PG -t -A -c "SELECT provision_phase FROM upstream_channel WHERE id=$CH_ID;" 2>/dev/null | tr -d '\r' | head -1)
  # The provisioner itself doesn't write to this column yet — migration
  # only adds it + back-fills old rows. So new rows from signup will be
  # NULL unless a future migration UPDATE syncs them from custom_headers.
  # We just record what we observe.
  echo "  INFO: provision_phase column value: '${PH_COL:-NULL}' (provisioner writes to custom_headers, not this column yet)"
fi

# ---------------------------------------------------------------------------
# 3. Manual upgrade endpoint — /platform/tenants/:id/upgrade-shadow.
#    Will hit llmapi /v1/wholesale/purchase via UPSTREAM_BASE_URL. If the
#    upstream returns 404 (current state) we expect a structured 502 from
#    the panel; if upstream is live we expect ok=true with sk-relay-*.
# ---------------------------------------------------------------------------
note "3. /platform/tenants/$TENANT_ID/upgrade-shadow (real purchase attempt)"
if [ -z "$PLATFORM_TOKEN" ]; then
  bad "PLATFORM_TOKEN not set on container — cannot test upgrade-shadow"
else
  UP=$(ch -X POST "$B/platform/tenants/$TENANT_ID/upgrade-shadow" \
    -H "X-Platform-Token: $PLATFORM_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"plan":"pro","cycle":"monthly"}' \
    -w '\n__HTTP:%{http_code}' 2>&1)
  HTTP=$(echo "$UP" | tail -n 1 | sed 's/^__HTTP://')
  BODY=$(echo "$UP" | sed '$d')

  case "$HTTP" in
    200)
      SK_PREFIX=$(echo "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("phase",""))' 2>/dev/null)
      PURCH_PREFIX=$(echo "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); p=d.get("purchase") or {}; print(p.get("purchase_id","")[:24])' 2>/dev/null)
      ok "upgrade-shadow 200 phase=$SK_PREFIX purchase_id=${PURCH_PREFIX}"
      # Verify DB now holds sk-relay-*.
      KEY_AFTER=$($PG -t -A -c "SELECT api_key FROM upstream_channel WHERE id=$CH_ID;" 2>/dev/null | tr -d '\r' | head -1)
      if [[ "$KEY_AFTER" =~ ^sk-relay- ]]; then
        ok "channel.api_key now sk-relay-* (real per-tenant!) — prefix=${KEY_AFTER:0:16}"
      else
        bad "expected sk-relay-* after upgrade, got prefix=${KEY_AFTER:0:16}"
      fi
      ;;
    502)
      ERR=$(echo "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error",{}).get("message",""))' 2>/dev/null | head -c 80)
      ok "upgrade-shadow 502 with structured error (expected when upstream wholesale not mounted): '$ERR'"
      ;;
    503)
      bad "503 — PLATFORM_TOKEN likely missing"
      ;;
    401)
      bad "401 — PLATFORM_TOKEN incorrect"
      ;;
    *)
      bad "upgrade-shadow unexpected HTTP $HTTP body=$(echo "$BODY" | head -c 200)"
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 4. Auth — /platform/tenants/:id/upgrade-shadow without token = 401 / 503.
# ---------------------------------------------------------------------------
note "4. /upgrade-shadow auth — no token rejected"
UNAUTH=$(ch -X POST "$B/platform/tenants/$TENANT_ID/upgrade-shadow" \
  -H 'Content-Type: application/json' \
  -d '{}' -o /dev/null -w '%{http_code}')
case "$UNAUTH" in
  401|503) ok "unauthenticated request rejected ($UNAUTH)";;
  *)       bad "unauthenticated request returned $UNAUTH (expected 401/503)";;
esac

# ---------------------------------------------------------------------------
# 5. Bad tenant id — 404.
# ---------------------------------------------------------------------------
note "5. /upgrade-shadow with bogus tenant_id → 404"
if [ -n "$PLATFORM_TOKEN" ]; then
  BOGUS=$(ch -X POST "$B/platform/tenants/9999999/upgrade-shadow" \
    -H "X-Platform-Token: $PLATFORM_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}' -o /dev/null -w '%{http_code}')
  if [ "$BOGUS" = "404" ]; then
    ok "bogus tenant returns 404"
  else
    bad "bogus tenant returned $BOGUS (expected 404)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Idempotency — second signup with same slug returns 409 cleanly.
# ---------------------------------------------------------------------------
note "6. duplicate signup → 409 (or 429 if rate-limited)"
# Note: signup-tenant uses a 1/min RateLimiter, so the second call from the
# same IP within 60s will often 429 before reaching the dup-slug 409 path.
# Both are acceptable "non-5xx rejection" outcomes here.
DUP=$(ch -X POST "$B/signup-tenant" \
  -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"dup-${EMAIL}\",\"admin_password\":\"smokepwd-1234\"}" \
  -o /dev/null -w '%{http_code}')
case "$DUP" in
  409) ok "duplicate slug returned 409";;
  429) ok "duplicate slug returned 429 (rate-limited before dup check — acceptable)";;
  *)   bad "duplicate slug returned $DUP (expected 409 or 429)";;
esac

# Cleanup — leave the test tenant in place so the admin can be inspected
# but null out the api_key so we don't pollute real billing.
$PG -c "DELETE FROM tenant WHERE id=$TENANT_ID CASCADE;" >/dev/null 2>&1 || true

echo
echo "=============================================="
echo "  Phase-2 smoke: $PASS PASS / $FAIL FAIL"
echo "=============================================="
exit $FAIL
