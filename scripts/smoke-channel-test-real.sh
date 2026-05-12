#!/bin/bash
# Smoke test — channel real healthCheck (v0.5).
#
# Creates one channel per provider_type with a fake bearer key, then POSTs
# /admin/channels/:id/test. We expect:
#   - openai/deepseek/moonshot/qwen/minimax → GET /v1/models with bearer.
#     fake key → 401/403 → ok:false category:'auth' (NOT 500 / NOT stub).
#   - gemini → GET /v1beta/models?key=… → 400/403 → ok:false category:'auth'.
#   - custom → GET base_url → ok:true (provider sites usually return 200).
#   - anthropic/llmapi-wholesale → already real in v0.3, sanity check only.
#
# What "real" means here: the test code MUST hit the upstream URL
# (latency_ms > 0, http status recorded) AND must NOT carry the v0.3
# 'not_implemented' category. We don't require the upstream to *succeed* —
# we only require that the panel actually called it.
#
# Requires:
#   - 3api-panel listening on :3199
#   - postgres on :5432 (db=relay_panel_3api, user=admin)
#   - admin admin@3api.pro password admin-3api-init-pwd-CHANGEME on tenant 1
set -uo pipefail

B=${B:-http://127.0.0.1:3199}
HOST_HDR="Host: default.3api.pro"
PG="docker exec postgres psql -q -U admin -d relay_panel_3api"

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

ch()  { curl -sS -m 15 -H "$HOST_HDR" "$@"; }

# Admin login on the default tenant.
ADMIN=$(ch -X POST "$B/admin/login" -H 'Content-Type: application/json' \
        -d '{"email":"admin@3api.pro","password":"admin-3api-init-pwd-CHANGEME"}')
ADMIN_TOK=$(echo "$ADMIN" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$ADMIN_TOK" ]; then
  echo "FATAL: admin login failed: $ADMIN"
  exit 1
fi
AUTH="Authorization: Bearer $ADMIN_TOK"

# Clean any prior smoke rows.
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name LIKE 'ch-test-smoke-%';" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Provider matrix. base_url points at the canonical public endpoint so a
# fake key produces a meaningful 401/403 rather than DNS failure.
# (Endpoints intentionally chosen for "auth check yields fast 4xx" — we
# don't want to hammer real production with messages traffic.)
# ---------------------------------------------------------------------------
declare -A PROVIDER_URLS=(
  ["openai"]="https://api.openai.com/v1"
  ["deepseek"]="https://api.deepseek.com/v1"
  ["moonshot"]="https://api.moonshot.cn/v1"
  ["qwen"]="https://dashscope.aliyuncs.com/compatible-mode/v1"
  ["minimax"]="https://api.minimax.chat/v1"
  ["gemini"]="https://generativelanguage.googleapis.com/v1beta"
  ["custom"]="https://example.com"
)

# Build a channel per provider, POST /test, parse result.
declare -A CH_IDS=()
for prov in openai deepseek moonshot qwen minimax gemini custom; do
  note "channel: provider_type=$prov"
  URL="${PROVIDER_URLS[$prov]}"
  NAME="ch-test-smoke-${prov}"
  CREATE=$(ch -X POST "$B/admin/channels" \
    -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$NAME\",\"base_url\":\"$URL\",\"api_key\":\"fake-key-1234\",\"provider_type\":\"$prov\",\"type\":\"byok-other\"}")
  ID=$(echo "$CREATE" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
  if [ -z "$ID" ]; then
    bad "create channel for $prov: $(echo "$CREATE" | head -c 200)"
    continue
  fi
  CH_IDS[$prov]=$ID
  ok "channel created id=$ID"

  # Run probe.
  TEST=$(ch -X POST "$B/admin/channels/$ID/test" -H "$AUTH" -o /tmp/ch-test-$prov.json -w '%{http_code}')
  if [ "$TEST" != "200" ]; then
    bad "$prov: POST /test returned HTTP $TEST"
    continue
  fi
  BODY=$(cat /tmp/ch-test-$prov.json)
  OKVAL=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)
  CATEGORY=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("category",""))' 2>/dev/null)
  STATUS=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
  LAT=$(echo "$BODY" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("latency_ms",""))' 2>/dev/null)
  echo "  → ok=$OKVAL category=$CATEGORY status=$STATUS latency_ms=$LAT"

  # The big regression: v0.4 returned category='not_implemented' for these
  # five. After v0.5, that's a smoke fail.
  if [ "$CATEGORY" = "not_implemented" ]; then
    bad "$prov: still stubbed (category=not_implemented) — real healthCheck not wired"
    continue
  fi

  # Some kind of HTTP status, or a network category, must be present —
  # proves the panel actually reached out.
  if [ -n "$STATUS" ] || [ "$CATEGORY" = "unreachable" ] || [ "$CATEGORY" = "ok" ]; then
    ok "$prov: real probe executed (category=$CATEGORY, status=$STATUS)"
  else
    bad "$prov: no status / latency / network err → probe may not have run"
    continue
  fi

  # latency_ms > 0 (or 'unreachable' with err) means a real fetch ran.
  if [ -n "$LAT" ] && [ "$LAT" != "None" ] && [ "$LAT" != "" ]; then
    ok "$prov: latency_ms=$LAT recorded"
  else
    # unreachable from a sandboxed test runner is acceptable too.
    if [ "$CATEGORY" = "unreachable" ]; then
      ok "$prov: unreachable from runner (DNS/network) — acceptable in sandbox"
    else
      bad "$prov: no latency_ms recorded"
    fi
  fi

  # For the OpenAI quintet + gemini, fake key with reachable host should be
  # 401/403 (auth) OR an unreachable category if the test runner has no
  # internet. Either is a PASS for "real call attempted".
  case "$prov" in
    openai|deepseek|moonshot|qwen|minimax|gemini)
      case "$CATEGORY" in
        auth|unreachable|ok|rate_limit) ok "$prov: result category=$CATEGORY (auth/unreachable expected with fake key)";;
        *) bad "$prov: unexpected category=$CATEGORY";;
      esac
      ;;
    custom)
      # custom is a GET base_url — example.com returns 200, but could be
      # blocked by DNS in some CI. Either ok or unreachable is fine.
      case "$CATEGORY" in
        ok|unreachable) ok "$prov: category=$CATEGORY";;
        *) bad "$prov: unexpected category=$CATEGORY";;
      esac
      ;;
  esac

  # last_test_result persisted in DB?
  PERSISTED=$($PG -t -A -c "SELECT last_test_result IS NOT NULL FROM upstream_channel WHERE id=$ID;" 2>/dev/null | tr -d '\r' | head -1)
  if [ "$PERSISTED" = "t" ]; then
    ok "$prov: last_test_result persisted"
  else
    bad "$prov: last_test_result NOT persisted (DB write failed)"
  fi
done

# ---------------------------------------------------------------------------
# Cleanup smoke rows so subsequent runs are idempotent.
# ---------------------------------------------------------------------------
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name LIKE 'ch-test-smoke-%';" >/dev/null 2>&1

echo
echo "=============================================="
echo "  Channel real healthCheck smoke: $PASS PASS / $FAIL FAIL"
echo "=============================================="
exit $FAIL
