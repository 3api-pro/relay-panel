#!/bin/bash
# Smoke test — Task #16 admin extras endpoints.
#
# Covers: /me, /brand (GET+PATCH), /orders (list + refund), /stats (7d+30d),
#         /change-password (good+bad old_password), /payment-config (mask + PATCH).
#
# Requires: 3api-panel on :3199, postgres on :5432, tenant id=1 (slug=default),
# default admin admin@3api.pro / admin-3api-init-pwd-CHANGEME.
set +e
B=http://127.0.0.1:3199/api
HOST_HDR="Host: default.3api.pro"
PG="psql -q -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

ADMIN_EMAIL=${ADMIN_EMAIL:-admin@3api.pro}
ADMIN_PW=${ADMIN_PW:-admin-3api-init-pwd-CHANGEME}

ch()  { curl -sS -m 10 -H "$HOST_HDR" "$@"; }
chw() { curl -sS -m 10 -H "$HOST_HDR" -w '\n__HTTP:%{http_code}' "$@"; }

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# Helper to extract HTTP code from chw output.
http_of() { echo "$1" | tail -n 1 | sed 's/^__HTTP://'; }
body_of() { echo "$1" | sed '$d'; }

# 0. Login as admin.
note "0. login"
LOGIN=$(ch -X POST "$B/admin/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")
TOK=$(echo "$LOGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$TOK" ]; then ok "logged in"; else bad "login failed: $LOGIN"; exit 1; fi
AUTH="Authorization: Bearer $TOK"

# 1. GET /admin/me — returns admin + tenant + brand
note "1. GET /admin/me"
ME=$(ch -H "$AUTH" "$B/admin/me")
HAS_ADMIN=$(echo "$ME" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if d.get("admin",{}).get("id") and d.get("admin",{}).get("email") else "")' 2>/dev/null)
HAS_TENANT=$(echo "$ME" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if d.get("tenant",{}).get("slug") == "default" else "")' 2>/dev/null)
HAS_BRAND=$(echo "$ME" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if "primary_color" in d.get("brand",{}) else "")' 2>/dev/null)
if [ -n "$HAS_ADMIN" ] && [ -n "$HAS_TENANT" ] && [ -n "$HAS_BRAND" ]; then
  ok "/me returns admin+tenant+brand bundle"
else
  bad "/me missing fields: $ME"
fi

# 2. GET /admin/brand — returns defaults if empty
note "2. GET /admin/brand"
BR=$(ch -H "$AUTH" "$B/admin/brand")
PC=$(echo "$BR" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("primary_color",""))' 2>/dev/null)
if echo "$PC" | grep -qE '^#[0-9a-fA-F]{3,8}$'; then ok "/brand returns primary_color=$PC"; else bad "/brand bad: $BR"; fi

# 3. PATCH /admin/brand
note "3. PATCH /admin/brand"
NEWNAME="Smoke Store $(date +%s)"
PB=$(ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"store_name\":\"$NEWNAME\",\"primary_color\":\"#ff6600\",\"announcement\":\"hello\"}" \
  "$B/admin/brand")
GOT_NAME=$(echo "$PB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("store_name",""))' 2>/dev/null)
GOT_COLOR=$(echo "$PB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("primary_color",""))' 2>/dev/null)
if [ "$GOT_NAME" = "$NEWNAME" ] && [ "$GOT_COLOR" = "#ff6600" ]; then
  ok "PATCH /brand persisted store_name + color"
else
  bad "PATCH /brand failed: $PB"
fi

# 3b. PATCH validation — bad color
note "3b. PATCH /brand bad color → 400"
BAD=$(chw -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"primary_color":"red"}' "$B/admin/brand")
if [ "$(http_of "$BAD")" = "400" ]; then ok "bad color rejected"; else bad "expected 400, got $(http_of "$BAD")"; fi

# 4. GET /admin/orders — list (paginate)
note "4. GET /admin/orders"
OL=$(ch -H "$AUTH" "$B/admin/orders?limit=5&page=1")
HAS_DATA=$(echo "$OL" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if isinstance(d.get("data"), list) else "")' 2>/dev/null)
HAS_TOTAL=$(echo "$OL" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if isinstance(d.get("total"), int) else "")' 2>/dev/null)
if [ -n "$HAS_DATA" ] && [ -n "$HAS_TOTAL" ]; then ok "orders list has data+total"; else bad "orders list bad: $OL"; fi

# 5. Setup: create one paid order for refund testing
note "5. seed order for refund test"
UID_S=$($PG -t -A -c "INSERT INTO end_user (tenant_id, email, password_hash, status) VALUES (1, 'refund-smoke-$(date +%s%N)@example.com', 'x', 'active') RETURNING id;" | tr -d ' ')
PID_S=$($PG -t -A -c "SELECT id FROM plans WHERE tenant_id=1 LIMIT 1;" | tr -d ' ')
if [ -z "$PID_S" ]; then
  PID_S=$($PG -t -A -c "INSERT INTO plans (tenant_id, name, slug, period_days, quota_tokens, price_cents, wholesale_face_value_cents, enabled) VALUES (1, 'Smoke', 'smoke-plan-$(date +%s)', 30, 1000000, 5000, 4000, true) RETURNING id;" | tr -d ' ')
fi
OID_S=$($PG -t -A -c "INSERT INTO orders (tenant_id, end_user_id, plan_id, amount_cents, currency, status, paid_at) VALUES (1, $UID_S, $PID_S, 5000, 'CNY', 'paid', NOW()) RETURNING id;" | tr -d ' ')
if [ -n "$OID_S" ]; then ok "seeded order $OID_S for user $UID_S plan $PID_S"; else bad "seed failed"; fi

# 6. POST /admin/orders/:id/refund — full amount
note "6. POST /admin/orders/$OID_S/refund"
RF=$(chw -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"reason":"smoke refund test"}' "$B/admin/orders/$OID_S/refund")
HTTP=$(http_of "$RF")
BODY=$(body_of "$RF")
RFID=$(echo "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refund_id",""))' 2>/dev/null)
ORD_STATUS=$($PG -t -A -c "SELECT status FROM orders WHERE id=$OID_S;" | tr -d ' ')
if [ "$HTTP" = "201" ] && [ -n "$RFID" ] && [ "$ORD_STATUS" = "refunded" ]; then
  ok "refund_id=$RFID, order now refunded"
else
  bad "refund failed HTTP=$HTTP body=$BODY status=$ORD_STATUS"
fi

# 6b. Refund again — order already refunded → 409
note "6b. POST refund on refunded order → 409"
RF2=$(chw -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"reason":"replay"}' "$B/admin/orders/$OID_S/refund")
if [ "$(http_of "$RF2")" = "409" ]; then ok "rejected double refund (409)"; else bad "expected 409, got $(http_of "$RF2"): $(body_of "$RF2")"; fi

# 7. GET /admin/stats?period=7d
note "7. GET /admin/stats?period=7d"
ST7=$(ch -H "$AUTH" "$B/admin/stats?period=7d")
P7=$(echo "$ST7" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("period",""))' 2>/dev/null)
BY_DAY_LEN=$(echo "$ST7" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("by_day",[])))' 2>/dev/null)
if [ "$P7" = "7d" ] && [ "$BY_DAY_LEN" = "7" ]; then ok "stats 7d period+by_day OK"; else bad "7d stats bad: $ST7"; fi

# 7b. /stats?period=30d&group=plan
note "7b. GET /admin/stats?period=30d&group=plan"
ST30=$(ch -H "$AUTH" "$B/admin/stats?period=30d&group=plan")
P30=$(echo "$ST30" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("period",""))' 2>/dev/null)
HAS_BY_PLAN=$(echo "$ST30" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("y" if isinstance(d.get("by_plan"), list) else "")' 2>/dev/null)
if [ "$P30" = "30d" ] && [ -n "$HAS_BY_PLAN" ]; then ok "stats 30d+by_plan OK"; else bad "30d stats bad: $ST30"; fi

# 8. GET /admin/payment-config — masking
note "8. GET /admin/payment-config (mask private_key)"
# Seed a private key first.
$PG -c "UPDATE tenant SET config = COALESCE(config,'{}'::jsonb) || '{\"payment_config\":{\"alipay_app_id\":\"appsmoke\",\"alipay_private_key\":\"-----BEGIN PRIVATE KEY-----abcdef1234XYZW9999\",\"usdt_trc20_address\":\"TSmoke1\",\"usdt_erc20_address\":\"0xSmoke2\"}}'::jsonb WHERE id=1;" >/dev/null
PC=$(ch -H "$AUTH" "$B/admin/payment-config")
APP=$(echo "$PC" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("alipay_app_id",""))' 2>/dev/null)
PK_MASK=$(echo "$PC" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("alipay_private_key",""))' 2>/dev/null)
PK_SET=$(echo "$PC" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("alipay_private_key_set",""))' 2>/dev/null)
if [ "$APP" = "appsmoke" ] && echo "$PK_MASK" | grep -q '^\*\*\*'; then
  ok "payment-config masks private_key=$PK_MASK (set=$PK_SET)"
else
  bad "payment-config bad: $PC"
fi

# 8b. PATCH /admin/payment-config — partial update keeps private_key
note "8b. PATCH /admin/payment-config (partial, keep private_key)"
PCP=$(ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"alipay_app_id":"appsmoke-updated","alipay_private_key":"***9999"}' \
  "$B/admin/payment-config")
NEW_APP=$(echo "$PCP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("alipay_app_id",""))' 2>/dev/null)
DB_PK=$($PG -t -A -c "SELECT config->'payment_config'->>'alipay_private_key' FROM tenant WHERE id=1;")
if [ "$NEW_APP" = "appsmoke-updated" ] && echo "$DB_PK" | grep -q 'BEGIN PRIVATE KEY'; then
  ok "patched app_id, kept private_key untouched (db still has full key)"
else
  bad "patch broke private_key: NEW_APP=$NEW_APP DB_PK=$DB_PK PCP=$PCP"
fi

# 9. POST /admin/change-password — wrong old → 401
note "9. POST /admin/change-password (wrong old)"
CPB=$(chw -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"old_password":"definitely-not-the-pw","new_password":"new-smoke-pw-12345"}' \
  "$B/admin/change-password")
if [ "$(http_of "$CPB")" = "401" ]; then ok "wrong old_password rejected with 401"; else bad "expected 401, got $(http_of "$CPB"): $(body_of "$CPB")"; fi

# 10. POST /admin/change-password — correct old → 200, then revert
note "10. POST /admin/change-password (correct old, then revert)"
NEW_PW="rotated-smoke-pw-$(date +%s)"
CP1=$(chw -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"old_password\":\"$ADMIN_PW\",\"new_password\":\"$NEW_PW\"}" \
  "$B/admin/change-password")
if [ "$(http_of "$CP1")" != "200" ]; then bad "change-password phase1 fail: $(http_of "$CP1") $(body_of "$CP1")"; else ok "rotated password"; fi

# Verify login with new password
LOGIN2=$(ch -X POST "$B/admin/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$NEW_PW\"}")
TOK2=$(echo "$LOGIN2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$TOK2" ]; then ok "login with rotated password succeeded"; else bad "login with new pw failed: $LOGIN2"; fi

# Revert to original so we don't break other tests / production assumptions
AUTH2="Authorization: Bearer $TOK2"
REV=$(chw -X POST -H "$AUTH2" -H 'Content-Type: application/json' \
  -d "{\"old_password\":\"$NEW_PW\",\"new_password\":\"$ADMIN_PW\"}" \
  "$B/admin/change-password")
if [ "$(http_of "$REV")" = "200" ]; then ok "reverted password to original"; else bad "revert failed: $(body_of "$REV")"; fi

# Cleanup — refund row is fine to keep; remove seeded order+user
$PG -c "DELETE FROM refund WHERE order_id=$OID_S;" >/dev/null 2>&1
$PG -c "DELETE FROM orders WHERE id=$OID_S;" >/dev/null 2>&1
$PG -c "DELETE FROM end_user WHERE id=$UID_S;" >/dev/null 2>&1

echo ""
echo "===================="
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
