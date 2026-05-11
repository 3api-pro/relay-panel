#!/bin/bash
# Smoke test — storefront (end_user + plans + orders + subscriptions + relay).
#
# Requires:
#   - 3api-panel running on :3199 (TENANT_MODE=multi, SAAS_DOMAIN=3api.pro)
#   - postgres on :5432, db=relay_panel_3api
#   - tenant id=1 (slug=default) with seeded plans
#   - mock upstream on :19999 (script starts it if not running)
#   - STOREFRONT_DEV_PAY_ENABLED=on in the container env (smoke checks it)
#
# Exit non-zero if any step fails; prints PASS/FAIL summary.
set +e
B=http://127.0.0.1:3199
HOST_HDR="Host: default.3api.pro"
PG="psql -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

# Helper: curl with Host header always set.
ch() { curl -sS -m 10 -H "$HOST_HDR" "$@"; }

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# --- 0. ensure mock upstream + an upstream_channel for tenant 1 ---
note "0. mock upstream + tenant-1 default channel"
if ! curl -sS -m 2 http://127.0.0.1:19999/v1/messages -X POST -H 'Authorization: Bearer test-byok-key-1234' -H 'Content-Type: application/json' -d '{"model":"x","messages":[]}' 2>&1 | grep -q "mock\|pong"; then
  echo "  starting mock upstream..."
  ( node /root/3api-relay-panel/scripts/mock-upstream.js >/tmp/mock-upstream.log 2>&1 & )
  sleep 1
fi

# Top up wholesale balance for tenant 1
$PG -c "INSERT INTO wholesale_balance (tenant_id, balance_cents) VALUES (1, 10000000) ON CONFLICT (tenant_id) DO UPDATE SET balance_cents = 10000000, updated_at = NOW();" >/dev/null

# Ensure a channel pointing at mock upstream exists for tenant 1
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name='smoke-mock';" >/dev/null
$PG -c "INSERT INTO upstream_channel (tenant_id, name, base_url, api_key, type, status, weight, priority, is_default, group_access) VALUES (1, 'smoke-mock', 'http://127.0.0.1:19999/v1', 'test-byok-key-1234', 'byok-claude', 'active', 100, 1, FALSE, 'default');" >/dev/null
$PG -c "UPDATE upstream_channel SET is_default=FALSE WHERE tenant_id=1;" >/dev/null
$PG -c "UPDATE upstream_channel SET is_default=TRUE WHERE tenant_id=1 AND name='smoke-mock';" >/dev/null
ok "tenant-1 wholesale topped up + mock channel set default"

# --- 1. end_user signup ---
note "1. /storefront/auth/signup"
EMAIL="smoke-$(date +%s%N)@example.com"
SIGNUP=$(ch -X POST $B/storefront/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke12345\"}")
echo "$SIGNUP" | head -c 400; echo
USER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
VER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("verify_token",""))' 2>/dev/null)
USER_ID=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user",{}).get("id",""))' 2>/dev/null)
if [ -n "$USER_TOK" ] && [ -n "$VER_TOK" ]; then ok "signup token + verify_token issued (user_id=$USER_ID)"; else bad "signup malformed"; fi

# --- 2. verify email ---
note "2. /storefront/auth/verify-email/:token"
V=$(ch -X POST $B/storefront/auth/verify-email/$VER_TOK)
echo "$V" | head -c 200; echo
if echo "$V" | grep -q '"ok":true'; then ok "email verified"; else bad "verify failed"; fi

# --- 3. login ---
note "3. /storefront/auth/login"
LOGIN=$(ch -X POST $B/storefront/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke12345\"}")
USER_TOK=$(echo "$LOGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$USER_TOK" ]; then ok "login returned token"; else bad "login failed: $LOGIN"; fi

# --- 4. admin login + list plans ---
note "4. /admin/login + GET /admin/plans"
ADMIN=$(ch -X POST $B/admin/login -H 'Content-Type: application/json' -d '{"email":"admin@3api.pro","password":"admin-3api-init-pwd-CHANGEME"}')
ADMIN_TOK=$(echo "$ADMIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$ADMIN_TOK" ]; then bad "admin login failed: $ADMIN"; fi
PLANS=$(ch $B/admin/plans -H "Authorization: Bearer $ADMIN_TOK")
PLAN_COUNT=$(echo "$PLANS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "${PLAN_COUNT:-0}" -ge 4 ] 2>/dev/null; then ok "admin sees $PLAN_COUNT plans"; else bad "expected ≥4 plans, got '$PLAN_COUNT' — $PLANS"; fi

# --- 5. admin create new plan + patch + soft delete ---
note "5. /admin/plans POST + PATCH + DELETE"
SLUG_SUFFIX="$(date +%s%N)"
CRT=$(ch -X POST $B/admin/plans -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Smoke Test Plan\",\"slug\":\"smoke-$SLUG_SUFFIX\",\"period_days\":7,\"quota_tokens\":1000000,\"price_cents\":999,\"wholesale_face_value_cents\":900,\"allowed_models\":[\"claude-*\"]}")
NEW_PLAN_ID=$(echo "$CRT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
if [ -n "$NEW_PLAN_ID" ]; then ok "POST created plan id=$NEW_PLAN_ID"; else bad "create failed: $CRT"; fi
PATCHED=$(ch -X PATCH $B/admin/plans/$NEW_PLAN_ID -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"price_cents":1999,"sort_order":99}')
if echo "$PATCHED" | grep -q '"price_cents":1999'; then ok "PATCH price_cents updated"; else bad "PATCH failed: $PATCHED"; fi
DEL_CODE=$(ch -o /tmp/del_out.json -w '%{http_code}' -X DELETE $B/admin/plans/$NEW_PLAN_ID -H "Authorization: Bearer $ADMIN_TOK")
if [ "$DEL_CODE" = "204" ]; then ok "DELETE hard-deleted unreferenced plan (HTTP 204)"; else bad "DELETE expected 204, got $DEL_CODE"; fi

# --- 6. public storefront plans + brand ---
note "6. /storefront/plans + /storefront/brand"
PUB=$(ch $B/storefront/plans)
PUB_COUNT=$(echo "$PUB" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "${PUB_COUNT:-0}" -ge 4 ] 2>/dev/null; then ok "public sees $PUB_COUNT plans"; else bad "public list malformed: $PUB"; fi
BRAND=$(ch $B/storefront/brand)
if echo "$BRAND" | grep -q '"primary_color"'; then ok "/storefront/brand returns config"; else bad "brand malformed: $BRAND"; fi

# --- 7. create order ---
note "7. /storefront/orders POST"
PLAN_ID=$(echo "$PUB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
ORDER=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID}")
ORDER_ID=$(echo "$ORDER" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
ORDER_AMT=$(echo "$ORDER" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("amount_cents",""))' 2>/dev/null)
if [ -n "$ORDER_ID" ]; then ok "order created id=$ORDER_ID amount_cents=$ORDER_AMT status=pending"; else bad "order create failed: $ORDER"; fi

# --- 8. idempotent re-post ---
note "8. /storefront/orders POST (idempotent key)"
IDEMP_K="smoke-idemp-$(date +%s%N)"
O1=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID,\"idempotency_key\":\"$IDEMP_K\"}")
O2=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID,\"idempotency_key\":\"$IDEMP_K\"}")
ID1=$(echo "$O1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
ID2=$(echo "$O2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
if [ -n "$ID1" ] && [ "$ID1" = "$ID2" ]; then ok "idempotency returns same order_id=$ID1"; else bad "idempotency mismatch ID1=$ID1 ID2=$ID2"; fi

# --- 9. dev-confirm-paid → subscription + sk-key ---
note "9. /storefront/orders/:id/dev-confirm-paid"
CONF=$(ch -X POST $B/storefront/orders/$ORDER_ID/dev-confirm-paid -H "Authorization: Bearer $USER_TOK")
echo "$CONF" | head -c 400; echo
SUB_ID=$(echo "$CONF" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("subscription") or {}).get("id",""))' 2>/dev/null)
RAW_KEY=$(echo "$CONF" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_key","") or "")' 2>/dev/null)
SHORTAGE=$(echo "$CONF" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("wholesale_shortage",""))' 2>/dev/null)
if [ -n "$SUB_ID" ] && [ -n "$RAW_KEY" ] && [ "$SHORTAGE" = "False" ]; then
  ok "paid+provisioned: subscription_id=$SUB_ID sk-key=${RAW_KEY:0:18}..."
else
  bad "confirm-paid failed: SUB_ID=$SUB_ID RAW_KEY_len=${#RAW_KEY} SHORTAGE=$SHORTAGE"
fi

# --- 10. /v1/messages with sk-key actually flows + decrements remaining_tokens ---
note "10. /v1/messages with subscription sk-key"
if [ -z "$SUB_ID" ] || [ -z "$RAW_KEY" ]; then
  bad "step 10 skipped — no SUB_ID/RAW_KEY from step 9"
else
  BEFORE=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$SUB_ID;")
  MSG=$(curl -sS -m 10 -H "$HOST_HDR" -w '\nHTTP:%{http_code}' -X POST $B/v1/messages \
    -H "Authorization: Bearer $RAW_KEY" -H 'Content-Type: application/json' \
    -d '{"model":"claude-sonnet-4-7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
  echo "$MSG" | head -c 400; echo
  HTTP=$(echo "$MSG" | grep -o 'HTTP:[0-9]*' | head -1)
  AFTER=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$SUB_ID;")
  USAGE_ROWS=$($PG -t -A -c "SELECT COUNT(*) FROM usage_log WHERE subscription_id=$SUB_ID;")
  DROP=$((BEFORE - AFTER))
  echo "  before=$BEFORE after=$AFTER drop=$DROP usage_rows=$USAGE_ROWS http=$HTTP"
  if [ "$HTTP" = "HTTP:200" ] && [ "$USAGE_ROWS" -ge 1 ] && [ "$DROP" -gt 0 ]; then
    ok "v1/messages 200 + remaining_tokens dropped $DROP + usage_log row written"
  else
    bad "relay flow: http=$HTTP usage_rows=$USAGE_ROWS drop=$DROP"
  fi
fi

# --- 11. wholesale insufficient → paid_pending_provision ---
note "11. wholesale_balance shortage → paid_pending_provision"
$PG -c "UPDATE wholesale_balance SET balance_cents=10 WHERE tenant_id=1;" >/dev/null
O3=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID}")
O3_ID=$(echo "$O3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
if [ -z "$O3_ID" ]; then
  bad "shortage test setup: order create failed: $O3"
else
  C3=$(ch -X POST $B/storefront/orders/$O3_ID/dev-confirm-paid -H "Authorization: Bearer $USER_TOK")
  SHORTAGE3=$(echo "$C3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("wholesale_shortage",""))' 2>/dev/null)
  STATUS3=$($PG -t -A -c "SELECT status FROM orders WHERE id=$O3_ID;")
  if [ "$SHORTAGE3" = "True" ] && [ "$STATUS3" = "paid_pending_provision" ]; then
    ok "shortage flagged + order.status=paid_pending_provision (no subscription issued)"
  else
    bad "shortage detection failed: shortage=$SHORTAGE3 status=$STATUS3 raw=$C3"
  fi
fi
$PG -c "UPDATE wholesale_balance SET balance_cents=10000000 WHERE tenant_id=1;" >/dev/null

# --- 12. forgot/reset password ---
note "12. /storefront/auth/forgot + reset"
FORGOT=$(ch -X POST $B/storefront/auth/forgot-password -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}")
RESET_TOK=$(echo "$FORGOT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reset_token") or "")' 2>/dev/null)
# NODE_ENV=production hides reset_token in API. Pull from DB so smoke runs anyway.
if [ -z "$RESET_TOK" ]; then
  RESET_TOK=$($PG -t -A -c "SELECT reset_token FROM end_user WHERE LOWER(email)=LOWER('$EMAIL');" | tr -d ' ')
fi
if [ -n "$RESET_TOK" ]; then
  RESET=$(ch -X POST $B/storefront/auth/reset-password -H 'Content-Type: application/json' -d "{\"token\":\"$RESET_TOK\",\"new_password\":\"newSmoke12345\"}")
  if echo "$RESET" | grep -q '"ok":true'; then
    LOGIN2=$(ch -X POST $B/storefront/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"newSmoke12345\"}")
    if echo "$LOGIN2" | grep -q '"token"'; then ok "forgot→reset→relogin OK"; else bad "post-reset login failed: $LOGIN2"; fi
  else bad "reset failed: $RESET"
  fi
else
  bad "forgot returned no reset_token: $FORGOT"
fi

# --- 13. admin wholesale topup ---
note "13. /admin/wholesale GET + topup"
WGET=$(ch $B/admin/wholesale -H "Authorization: Bearer $ADMIN_TOK")
if echo "$WGET" | grep -q '"balance_cents"'; then ok "GET /admin/wholesale shows balance"; else bad "GET failed: $WGET"; fi
WTOP=$(ch -X POST $B/admin/wholesale/topup -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' -d '{"amount_cents":100}')
if echo "$WTOP" | grep -q '"balance_cents"'; then ok "POST /admin/wholesale/topup OK"; else bad "topup failed: $WTOP"; fi

# --- 14. /storefront/orders GET + /storefront/subscriptions ---
note "14. /storefront/orders + /storefront/subscriptions"
OLST=$(ch $B/storefront/orders -H "Authorization: Bearer $USER_TOK")
OLC=$(echo "$OLST" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
SLST=$(ch $B/storefront/subscriptions -H "Authorization: Bearer $USER_TOK")
SLC=$(echo "$SLST" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "${OLC:-0}" -ge 1 ] && [ "${SLC:-0}" -ge 1 ]; then ok "user sees own orders=$OLC subscriptions=$SLC"; else bad "lists empty: orders=$OLC subs=$SLC"; fi

# --- summary ---
echo ""
echo "=========================================="
echo "smoke-storefront: $PASS PASS / $FAIL FAIL"
echo "=========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1
