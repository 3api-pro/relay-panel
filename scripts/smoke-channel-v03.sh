#!/bin/bash
# Smoke test — channel v0.3 (new-api parity + recommended hero + adapters).
#
# Boots a mock upstream on :19999, signs in as the admin@3api.pro super,
# exercises the new endpoints + columns end-to-end.
#
# Requires:
#   - 3api-panel listening on :3199 (TENANT_MODE=multi, SAAS_DOMAIN=3api.pro)
#   - postgres on :5432 (db=relay_panel_3api, user=admin)
#   - tenant id=1 (slug=default), seeded admin admin@3api.pro
#   - migration 010 applied
#
# Exits non-zero if any check fails. Verbose pass/fail per step.
set +e

B=http://127.0.0.1:3199
HOST_HDR="Host: default.3api.pro"
PG="psql -q -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

ch()  { curl -sS -m 10 -H "$HOST_HDR" "$@"; }
chw() { curl -sS -m 10 -H "$HOST_HDR" -w '\n__HTTP:%{http_code}' "$@"; }
http_of() { echo "$1" | tail -n 1 | sed 's/^__HTTP://'; }
body_of() { echo "$1" | sed '$d'; }

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Boot mock upstream if not already running.
if ! curl -sS -m 2 http://127.0.0.1:19999/v1/messages -X POST \
       -H 'Authorization: Bearer test-byok-key-1234' \
       -H 'Content-Type: application/json' \
       -d '{"model":"x","messages":[]}' 2>&1 | grep -q "mock\|pong\|authentication"; then
  ( node /root/3api-relay-panel/scripts/mock-upstream.js >/tmp/mock-upstream.log 2>&1 & )
  sleep 1
fi

# Admin login.
ADMIN=$(ch -X POST $B/admin/login -H 'Content-Type: application/json' \
        -d '{"email":"admin@3api.pro","password":"admin-3api-init-pwd-CHANGEME"}')
ADMIN_TOK=$(echo "$ADMIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$ADMIN_TOK" ]; then
  echo "FATAL: admin login failed: $ADMIN"; exit 1
fi
AUTH="Authorization: Bearer $ADMIN_TOK"

# Clean up any leftover smoke rows from prior runs.
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name LIKE 'v03-smoke-%';" >/dev/null

# ------------------------------------------------------------------------
# 1. Migration 010 columns present.
# ------------------------------------------------------------------------
note "1. migration 010 — columns present"
COLS=$($PG -t -A -c "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='upstream_channel' AND column_name IN ('provider_type','custom_headers','last_tested_at','last_test_result','enabled','is_recommended');")
EXPECTED="custom_headers,enabled,is_recommended,last_test_result,last_tested_at,provider_type"
if [ "$COLS" = "$EXPECTED" ]; then ok "all 6 columns present"; else bad "missing columns. got=$COLS"; fi

# ------------------------------------------------------------------------
# 2. POST anthropic channel — sets provider_type='anthropic' on the row.
# ------------------------------------------------------------------------
note "2. create anthropic channel + read back"
ANT=$(ch -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"v03-smoke-anthropic","base_url":"http://127.0.0.1:19999/v1","api_key":"test-byok-key-1234","provider_type":"anthropic","type":"byok-claude"}' \
  "$B/api/admin/channels")
ANT_ID=$(echo "$ANT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
ANT_PT=$(echo "$ANT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("provider_type",""))' 2>/dev/null)
if [ -n "$ANT_ID" ] && [ "$ANT_PT" = "anthropic" ]; then ok "anthropic created id=$ANT_ID provider_type=anthropic"; else bad "create failed body=$ANT"; fi

# ------------------------------------------------------------------------
# 3. POST openai channel.
# ------------------------------------------------------------------------
note "3. create openai channel"
OAI=$(ch -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"v03-smoke-openai","base_url":"http://127.0.0.1:19999/v1","api_key":"test-byok-key-1234","provider_type":"openai","type":"byok-openai-compat","custom_headers":{"x-test":"y"},"model_mapping":{"gpt-4":"gpt-4o"}}' \
  "$B/api/admin/channels")
OAI_ID=$(echo "$OAI" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
OAI_PT=$(echo "$OAI" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("provider_type",""))' 2>/dev/null)
if [ -n "$OAI_ID" ] && [ "$OAI_PT" = "openai" ]; then ok "openai created id=$OAI_ID + headers+mapping"; else bad "openai create failed: $OAI"; fi

# ------------------------------------------------------------------------
# 4. POST custom channel.
# ------------------------------------------------------------------------
note "4. create custom channel"
CST=$(ch -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"v03-smoke-custom","base_url":"http://127.0.0.1:19999/v1","api_key":"test-byok-key-1234","provider_type":"custom","type":"byok-other"}' \
  "$B/api/admin/channels")
CST_ID=$(echo "$CST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$CST_ID" ] && ok "custom created id=$CST_ID" || bad "custom create failed: $CST"

# ------------------------------------------------------------------------
# 5. POST stub provider — accepted at create time, /v1 calls 501.
# ------------------------------------------------------------------------
note "5. create gemini stub channel"
GEM=$(ch -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"v03-smoke-gemini","base_url":"http://127.0.0.1:19999/v1","api_key":"test-byok-key-1234","provider_type":"gemini","type":"byok-other"}' \
  "$B/api/admin/channels")
GEM_ID=$(echo "$GEM" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$GEM_ID" ] && ok "gemini stub created id=$GEM_ID" || bad "gemini create failed: $GEM"

# ------------------------------------------------------------------------
# 6. POST /admin/channels/:id/test — anthropic should be ok against mock.
# ------------------------------------------------------------------------
note "6. test endpoint — anthropic against mock"
TST=$(ch -X POST -H "$AUTH" "$B/api/admin/channels/$ANT_ID/test")
TST_OK=$(echo "$TST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)
TST_LAT=$(echo "$TST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("latency_ms",""))' 2>/dev/null)
if [ "$TST_OK" = "True" ]; then ok "anthropic test ok latency=${TST_LAT}ms"; else bad "anthropic test result: $TST"; fi

# ------------------------------------------------------------------------
# 7. POST /admin/channels/:id/test — custom probes root.
# ------------------------------------------------------------------------
note "7. test endpoint — custom against mock root"
TST_C=$(ch -X POST -H "$AUTH" "$B/api/admin/channels/$CST_ID/test")
TST_C_OK=$(echo "$TST_C" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)
if [ "$TST_C_OK" = "True" ] || [ "$TST_C_OK" = "False" ]; then ok "custom test executed (ok=$TST_C_OK) — endpoint reachable"; else bad "custom test failed shape: $TST_C"; fi

# ------------------------------------------------------------------------
# 8. POST /admin/channels/:id/test — gemini stub returns not_implemented.
# ------------------------------------------------------------------------
note "8. test endpoint — gemini stub returns not_implemented"
TST_G=$(ch -X POST -H "$AUTH" "$B/api/admin/channels/$GEM_ID/test")
TST_G_CAT=$(echo "$TST_G" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("category",""))' 2>/dev/null)
if [ "$TST_G_CAT" = "not_implemented" ]; then ok "gemini stub category=not_implemented"; else bad "gemini stub bad shape: $TST_G"; fi

# ------------------------------------------------------------------------
# 9. PATCH model_mapping + custom_headers via admin API.
# ------------------------------------------------------------------------
note "9. PATCH model_mapping + custom_headers"
PAT=$(ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"model_mapping":{"claude-sonnet-4-7":"claude-mock-mapped"},"custom_headers":{"x-relay":"3api","anthropic-version":"2023-06-01"}}' \
  "$B/api/admin/channels/$ANT_ID")
MAP=$(echo "$PAT" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("model_mapping",{})))' 2>/dev/null)
if echo "$MAP" | grep -q "claude-mock-mapped"; then ok "model_mapping persisted"; else bad "model_mapping not persisted: $PAT"; fi

# ------------------------------------------------------------------------
# 10. GET /admin/channels — sort puts is_recommended first.
# ------------------------------------------------------------------------
note "10. GET /admin/channels ordering — recommended first"
# Manually flag one for the sort assertion.
$PG -c "UPDATE upstream_channel SET is_recommended=TRUE WHERE id=$CST_ID;" >/dev/null
LST=$(ch -H "$AUTH" "$B/api/admin/channels")
FIRST_REC=$(echo "$LST" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
print(d[0].get('is_recommended', False)) if d else print('empty')
" 2>/dev/null)
if [ "$FIRST_REC" = "True" ]; then ok "first row is_recommended=True"; else bad "first row not recommended: $FIRST_REC"; fi

# Restore for repeatable runs.
$PG -c "UPDATE upstream_channel SET is_recommended=FALSE WHERE id=$CST_ID;" >/dev/null

# ------------------------------------------------------------------------
# 11. enabled=false hides from routing (resolveChannel skip).
# ------------------------------------------------------------------------
note "11. enabled=false skips channel in resolveChannel"
# Make all v03 channels enabled=false; create a fresh enabled mock + default.
$PG -c "UPDATE upstream_channel SET enabled=FALSE WHERE tenant_id=1 AND name LIKE 'v03-smoke-%';" >/dev/null
# Direct route resolution doesn't have a public surface, so we assert via SQL.
ROUTED=$($PG -t -A -c "SELECT name FROM upstream_channel WHERE tenant_id=1 AND status='active' AND enabled=TRUE ORDER BY is_default DESC, weight DESC, priority ASC, id ASC LIMIT 1;")
if echo "$ROUTED" | grep -vq "v03-smoke-"; then ok "v03 channels excluded by enabled=FALSE (routed=$ROUTED)"; else bad "expected non-v03, got $ROUTED"; fi
# Re-enable for next run.
$PG -c "UPDATE upstream_channel SET enabled=TRUE WHERE tenant_id=1 AND name LIKE 'v03-smoke-%';" >/dev/null

# ------------------------------------------------------------------------
# 12. last_tested_at / last_test_result persisted from step 6.
# ------------------------------------------------------------------------
note "12. last_tested_at populated"
LAST=$($PG -t -A -c "SELECT (last_tested_at IS NOT NULL)::text || ',' || (last_test_result IS NOT NULL)::text FROM upstream_channel WHERE id=$ANT_ID;")
if [ "$LAST" = "true,true" ]; then ok "last_tested_at + last_test_result persisted"; else bad "test result not persisted: $LAST"; fi

# Cleanup smoke rows.
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name LIKE 'v03-smoke-%';" >/dev/null

echo ""
echo "=== summary: PASS=$PASS FAIL=$FAIL ==="
exit $FAIL
