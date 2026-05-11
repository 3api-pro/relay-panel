#!/bin/bash
# Smoke test — payments + email (Alipay + USDT + Resend 5 templates).
#
# Requires:
#   - 3api-panel running on :3199 (TENANT_MODE=multi, SAAS_DOMAIN=3api.pro)
#   - postgres on :5432, db=relay_panel_3api
#   - tenant id=1 (slug=default) with seeded plans
#   - In-container env:
#       ALIPAY_GATEWAY=sandbox
#       RESEND_API_KEY=test
#       USDT_WATCHER_ENABLED=off  (we drive it manually)
#       EMAIL_CRON_ENABLED=off
#   - usdt addresses set in tenant.config.payment_config (this script
#     writes defaults if missing).
#
# Exits 0 iff all PASS.
set +e
B=http://127.0.0.1:3199
HOST_HDR="Host: default.3api.pro"
PG="psql -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

ch() { curl -sS -m 10 -H "$HOST_HDR" "$@"; }

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# --- 0. setup: tenant alipay+usdt config, wholesale topup, mock-observed table ---
note "0. setup tenant config + mock-observed table + plans"
$PG -c "INSERT INTO wholesale_balance (tenant_id, balance_cents) VALUES (1, 10000000) ON CONFLICT (tenant_id) DO UPDATE SET balance_cents = 10000000, updated_at = NOW();" >/dev/null
$PG -c "UPDATE tenant SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('payment_config', jsonb_build_object('alipay_app_id','dev','alipay_private_key','dev','alipay_public_key','dev','usdt_trc20_address','TSmokeAddrTRC20Default00000000000','usdt_erc20_address','0xSmokeAddrERC20Default0000000000000000000'), 'email_config', jsonb_build_object('email_from','smoke@default.3api.pro')) WHERE id = 1;" >/dev/null
$PG -c "INSERT INTO brand_config (tenant_id, store_name, primary_color, contact_email) VALUES (1, 'Smoke Default Store', '#6366f1', 'owner@smoke.example.com') ON CONFLICT (tenant_id) DO UPDATE SET store_name=EXCLUDED.store_name, contact_email=EXCLUDED.contact_email;" >/dev/null
$PG -c "CREATE TABLE IF NOT EXISTS usdt_chain_observed_mock (id SERIAL PRIMARY KEY, txn_hash VARCHAR(128) NOT NULL, from_address VARCHAR(64), to_address VARCHAR(64), value_usdt NUMERIC(18,6) NOT NULL, ts BIGINT NOT NULL DEFAULT 0, consumed BOOLEAN NOT NULL DEFAULT FALSE);" >/dev/null
$PG -c "DELETE FROM usdt_chain_observed_mock;" >/dev/null
ok "tenant config + mock-observed table ready"

# --- 1. signup + verify (uses email template internally) ---
note "1. /storefront/auth/signup → verify → login"
EMAIL="pay-$(date +%s%N)@example.com"
SIGNUP=$(ch -X POST $B/storefront/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke12345\"}")
USER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
VER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("verify_token",""))' 2>/dev/null)
if [ -n "$USER_TOK" ] && [ -n "$VER_TOK" ]; then ok "signup ok user_tok+verify_token"; else bad "signup failed: $SIGNUP"; fi

# --- 2. fetch plan ---
note "2. fetch a plan"
PUB=$(ch $B/storefront/plans)
PLAN_ID=$(echo "$PUB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
if [ -n "$PLAN_ID" ]; then ok "plan_id=$PLAN_ID"; else bad "no plan available: $PUB"; fi

# --- 3. create order ---
note "3. create order"
ORD=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID}")
ORDER_ID=$(echo "$ORD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
ORDER_AMT=$(echo "$ORD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("amount_cents",""))' 2>/dev/null)
if [ -n "$ORDER_ID" ]; then ok "order_id=$ORDER_ID amount_cents=$ORDER_AMT"; else bad "create failed: $ORD"; fi

# --- 4. alipay create QR (sandbox/mock) ---
note "4. POST /storefront/payments/alipay/create"
AP=$(ch -X POST $B/storefront/payments/alipay/create -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"order_id\":$ORDER_ID}")
echo "$AP" | head -c 300; echo
AP_QR=$(echo "$AP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("qr_code_url",""))' 2>/dev/null)
AP_OUT=$(echo "$AP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("out_trade_no",""))' 2>/dev/null)
AP_MODE=$(echo "$AP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mode",""))' 2>/dev/null)
if [ -n "$AP_QR" ] && [ -n "$AP_OUT" ] && [ "$AP_MODE" = "mock" ]; then ok "alipay create QR mode=mock out=$AP_OUT"; else bad "alipay create failed: $AP"; fi

# --- 5. alipay notify (mock TRADE_SUCCESS) → confirmPaid ---
note "5. POST /payments/alipay/notify (mock)"
AT_AMT=$(echo "scale=2; $ORDER_AMT / 100" | bc)
NOTIFY=$(curl -sS -m 10 -X POST $B/payments/alipay/notify -H 'Content-Type: application/x-www-form-urlencoded' --data "out_trade_no=$AP_OUT&trade_no=2026MOCK0001&total_amount=$AT_AMT&trade_status=TRADE_SUCCESS")
echo "  notify resp: '$NOTIFY'"
STATUS_AFTER=$($PG -t -A -c "SELECT status FROM orders WHERE id=$ORDER_ID;" | tr -d ' ')
SUB_ID=$($PG -t -A -c "SELECT id FROM subscription WHERE order_id=$ORDER_ID LIMIT 1;" | tr -d ' ')
HAS_TOK=$($PG -t -A -c "SELECT id FROM end_token WHERE subscription_id=COALESCE($SUB_ID,0) LIMIT 1;" | tr -d ' ')
if [ "$NOTIFY" = "success" ] && [ "$STATUS_AFTER" = "paid" ] && [ -n "$SUB_ID" ] && [ -n "$HAS_TOK" ]; then
  ok "alipay notify → confirmPaid → subscription_id=$SUB_ID + sk-token issued"
else
  bad "alipay confirm flow broke notify='$NOTIFY' status=$STATUS_AFTER sub=$SUB_ID tok=$HAS_TOK"
fi

# --- 6. alipay notify idempotent (replay) ---
note "6. alipay notify replay → idempotent"
NOTIFY2=$(curl -sS -m 10 -X POST $B/payments/alipay/notify -H 'Content-Type: application/x-www-form-urlencoded' --data "out_trade_no=$AP_OUT&trade_no=2026MOCK0001&total_amount=$AT_AMT&trade_status=TRADE_SUCCESS")
SUB_AFTER=$($PG -t -A -c "SELECT COUNT(*) FROM subscription WHERE order_id=$ORDER_ID;" | tr -d ' ')
TOK_AFTER=$($PG -t -A -c "SELECT COUNT(*) FROM end_token WHERE subscription_id=COALESCE($SUB_ID,0);" | tr -d ' ')
if [ "$NOTIFY2" = "success" ] && [ "$SUB_AFTER" = "1" ] && [ "$TOK_AFTER" = "1" ]; then
  ok "replay still 'success' + no duplicate subscription/token (idempotent)"
else
  bad "replay misbehaved notify2='$NOTIFY2' subs=$SUB_AFTER toks=$TOK_AFTER"
fi

# --- 7. alipay notify bad signature → fail in live mode (sandbox auto-fails ts checker)
note "7. alipay notify malformed out_trade_no → fail"
NBAD=$(curl -sS -m 10 -X POST $B/payments/alipay/notify -H 'Content-Type: application/x-www-form-urlencoded' --data "out_trade_no=garbage&trade_status=TRADE_SUCCESS")
if [ "$NBAD" = "fail" ]; then ok "rejected garbage notify with 'fail'"; else bad "expected fail, got '$NBAD'"; fi

# --- 8. usdt create order + payment intent ---
note "8. /storefront/payments/usdt/create"
ORD2=$(ch -X POST $B/storefront/orders -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"plan_id\":$PLAN_ID}")
ORDER2_ID=$(echo "$ORD2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
UP=$(ch -X POST $B/storefront/payments/usdt/create -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"order_id\":$ORDER2_ID,\"network\":\"trc20\"}")
echo "$UP" | head -c 300; echo
UP_ADDR=$(echo "$UP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address",""))' 2>/dev/null)
UP_AMT=$(echo "$UP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("amount",""))' 2>/dev/null)
UP_NET=$(echo "$UP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("network",""))' 2>/dev/null)
if [ -n "$UP_ADDR" ] && [ -n "$UP_AMT" ] && [ "$UP_NET" = "trc20" ]; then
  ok "usdt intent: net=$UP_NET addr=${UP_ADDR:0:12}... amount=$UP_AMT"
else
  bad "usdt create failed: $UP"
fi

# --- 9. usdt check pending → not matched ---
note "9. /storefront/payments/usdt/check before chain hit"
UC1=$(ch -X POST $B/storefront/payments/usdt/check -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"order_id\":$ORDER2_ID}")
UC1_STATUS=$(echo "$UC1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
if [ "$UC1_STATUS" = "pending" ]; then ok "pre-hit status=pending"; else bad "pre-hit expected pending got '$UC1_STATUS': $UC1"; fi

# --- 10. simulate chain hit + check → matched ---
note "10. insert mock chain txn + check → matched + subscription"
$PG -c "INSERT INTO usdt_chain_observed_mock (txn_hash, from_address, to_address, value_usdt, ts) VALUES ('mockTxn$ORDER2_ID', 'TFromSmoke', '$UP_ADDR', $UP_AMT, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000);" >/dev/null
UC2=$(ch -X POST $B/storefront/payments/usdt/check -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"order_id\":$ORDER2_ID}")
echo "$UC2" | head -c 200; echo
UC2_STATUS=$(echo "$UC2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
ORD2_STATUS=$($PG -t -A -c "SELECT status FROM orders WHERE id=$ORDER2_ID;" | tr -d ' ')
SUB2_ID=$($PG -t -A -c "SELECT id FROM subscription WHERE order_id=$ORDER2_ID LIMIT 1;" | tr -d ' ')
if [ "$UC2_STATUS" = "matched" ] && [ "$ORD2_STATUS" = "paid" ] && [ -n "$SUB2_ID" ]; then
  ok "usdt matched + order paid + subscription_id=$SUB2_ID"
else
  bad "usdt match broke: status=$UC2_STATUS order=$ORD2_STATUS sub=$SUB2_ID"
fi

# --- 11. usdt check idempotent (already matched) ---
note "11. /storefront/payments/usdt/check after match"
UC3=$(ch -X POST $B/storefront/payments/usdt/check -H "Authorization: Bearer $USER_TOK" -H 'Content-Type: application/json' -d "{\"order_id\":$ORDER2_ID}")
UC3_STATUS=$(echo "$UC3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)
SUB2_AFTER=$($PG -t -A -c "SELECT COUNT(*) FROM subscription WHERE order_id=$ORDER2_ID;" | tr -d ' ')
if [ "$UC3_STATUS" = "matched" ] && [ "$SUB2_AFTER" = "1" ]; then ok "still matched + no duplicate subscription"; else bad "post-match check broke status=$UC3_STATUS subs=$SUB2_AFTER"; fi

# --- 12. resend test-mode renders all 5 templates --------------------------
# Drop a one-shot harness into the container, then exec it. Init DB first.
note "12. email render — all 5 templates in test-mode"
docker exec 3api-panel sh -c 'cat > /tmp/render_test.js << "JSEOF"
process.env.RESEND_API_KEY = "test";
const { initDatabase } = require("/app/dist/services/database");
async function run() {
  await initDatabase();
  const { sendEmail } = require("/app/dist/services/email-resend");
  const t = ["verify-email","order-success","subscription-expiring","refund-confirmation","wholesale-low"];
  const dataMap = {
    "verify-email": { email: "x@y.com", verify_token: "vt123" },
    "order-success": { plan_name: "Pro", amount_cents: 9900, currency: "CNY", raw_key: "sk-relay-test", expires_at: new Date(Date.now()+86400000*30).toISOString(), order_id: 1 },
    "subscription-expiring": { plan_name: "Pro", expires_at: new Date(Date.now()+86400000*3).toISOString(), days_left: 3 },
    "refund-confirmation": { order_id: 1, amount_cents: 9900, currency: "CNY", reason: "customer asked" },
    "wholesale-low": { balance_cents: 100, currency: "CNY", tenant_slug: "default" },
  };
  let okN = 0;
  for (const tmpl of t) {
    const r = await sendEmail({ to: "smoke@example.com", template: tmpl, data: dataMap[tmpl], tenantId: 1 });
    if (r.ok) okN++;
    console.log(tmpl, r.ok ? "ok" : "FAIL", r.mode);
  }
  console.log("TOTAL", okN, "/", t.length);
  process.exit(okN === t.length ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(2); });
JSEOF
'
RENDERS=$(docker exec -e RESEND_API_KEY=test 3api-panel node /tmp/render_test.js 2>&1)
echo "$RENDERS"
if echo "$RENDERS" | grep -q "TOTAL 5 / 5"; then ok "all 5 templates rendered + logged"; else bad "template render failed"; fi

# --- 13. expiring-soon cron sweep ------------------------------------------
note "13. trigger sweepExpiringSubscriptions"
if [ -n "$SUB_ID" ]; then
  $PG -c "UPDATE subscription SET expires_at = NOW() + interval '3 days 5 hours', reminder_sent_at = NULL WHERE id = $SUB_ID;" >/dev/null
  docker exec 3api-panel sh -c 'cat > /tmp/cron_expiring.js << "JSEOF"
process.env.RESEND_API_KEY = "test";
const { initDatabase } = require("/app/dist/services/database");
(async () => {
  await initDatabase();
  const n = await require("/app/dist/services/email-cron").sweepExpiringSubscriptions();
  console.log("SENT", n);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
JSEOF
'
  SWP=$(docker exec -e RESEND_API_KEY=test 3api-panel node /tmp/cron_expiring.js 2>&1)
  echo "$SWP" | head -c 200; echo
  REMINDER_TS=$($PG -t -A -c "SELECT reminder_sent_at FROM subscription WHERE id=$SUB_ID;" | tr -d ' ')
  if echo "$SWP" | grep -q "SENT 1" && [ -n "$REMINDER_TS" ]; then ok "expiring sweep: 1 email + reminder_sent_at set"; else bad "sweep broke: $SWP reminder_ts=$REMINDER_TS"; fi
else
  bad "no SUB_ID for expiring sweep"
fi

# --- 14. wholesale-low cron sweep ------------------------------------------
note "14. trigger sweepLowWholesale"
$PG -c "UPDATE wholesale_balance SET balance_cents = 100, low_warning_sent_at = NULL WHERE tenant_id = 1;" >/dev/null
docker exec 3api-panel sh -c 'cat > /tmp/cron_low.js << "JSEOF"
process.env.RESEND_API_KEY = "test";
const { initDatabase } = require("/app/dist/services/database");
(async () => {
  await initDatabase();
  const n = await require("/app/dist/services/email-cron").sweepLowWholesale();
  console.log("SENT", n);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
JSEOF
'
SWPLOW=$(docker exec -e RESEND_API_KEY=test 3api-panel node /tmp/cron_low.js 2>&1)
echo "$SWPLOW" | head -c 200; echo
LOW_TS=$($PG -t -A -c "SELECT low_warning_sent_at FROM wholesale_balance WHERE tenant_id=1;" | tr -d ' ')
if echo "$SWPLOW" | grep -q "SENT 1" && [ -n "$LOW_TS" ]; then ok "low-wholesale sweep: 1 email + low_warning_sent_at set"; else bad "low sweep broke: $SWPLOW low_ts=$LOW_TS"; fi
$PG -c "UPDATE wholesale_balance SET balance_cents = 10000000 WHERE tenant_id = 1;" >/dev/null

# --- summary ---
echo ""
echo "=========================================="
echo "smoke-payments: $PASS PASS / $FAIL FAIL"
echo "=========================================="
[ $FAIL -eq 0 ] && exit 0 || exit 1
