#!/bin/bash
# Smoke test — v0.3 dual-billing (subscription + token_pack).
#
# Validates:
#   - migration 009 applied (plans.billing_type column + check constraint)
#   - admin can create token_pack plan; period_days force-clamped to 3650
#   - /storefront/plans returns both billing_type flavours
#   - end_user buys both a subscription AND a token_pack → 2 active subs
#   - /v1/messages debits oldest-expires-first (subscription drains before pack)
#   - subscription empty + pack non-empty → /v1/messages still 200
#   - both empty → /v1/messages 402 insufficient_quota
#   - /storefront/balance returns 3 numbers split by type
#   - idempotency_key still works on token_pack orders
#   - bonus: admin PATCH a token_pack with period_days=30 still clamps to 3650
#
# Requires:
#   - 3api-panel on :3199 (TENANT_MODE=multi)
#   - postgres on :5432 (db=relay_panel_3api, user=admin)
#   - mock upstream on :19999 (auto-start)
#   - STOREFRONT_DEV_PAY_ENABLED=on in panel env
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

# ------------------------------------------------------------------------
# 0. setup: mock upstream, wholesale topup, admin token, default channel
# ------------------------------------------------------------------------
note "0. setup"
if ! curl -sS -m 2 http://127.0.0.1:19999/v1/messages -X POST \
       -H 'Authorization: Bearer test-byok-key-1234' \
       -H 'Content-Type: application/json' \
       -d '{"model":"x","messages":[]}' 2>&1 | grep -q "mock\|pong"; then
  ( node /root/3api-relay-panel/scripts/mock-upstream.js >/tmp/mock-upstream.log 2>&1 & )
  sleep 1
fi
$PG -c "INSERT INTO wholesale_balance (tenant_id, balance_cents) VALUES (1, 10000000) ON CONFLICT (tenant_id) DO UPDATE SET balance_cents = 10000000, updated_at = NOW();" >/dev/null
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name='dual-smoke-mock';" >/dev/null
$PG -c "INSERT INTO upstream_channel (tenant_id, name, base_url, api_key, type, status, weight, priority, is_default, group_access) VALUES (1, 'dual-smoke-mock', 'http://127.0.0.1:19999/v1', 'test-byok-key-1234', 'byok-claude', 'active', 100, 1, FALSE, 'default');" >/dev/null
$PG -c "UPDATE upstream_channel SET is_default=FALSE WHERE tenant_id=1;" >/dev/null
$PG -c "UPDATE upstream_channel SET is_default=TRUE WHERE tenant_id=1 AND name='dual-smoke-mock';" >/dev/null

ADMIN=$(ch -X POST $B/admin/login -H 'Content-Type: application/json' -d '{"email":"admin@3api.pro","password":"admin-3api-init-pwd-CHANGEME"}')
ADMIN_TOK=$(echo "$ADMIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$ADMIN_TOK" ]; then bad "admin login failed: $ADMIN"; exit 1; fi
AUTH="Authorization: Bearer $ADMIN_TOK"
ok "setup complete"

# ------------------------------------------------------------------------
# 1. migration 009: plans.billing_type column exists + has check constraint
# ------------------------------------------------------------------------
note "1. plans.billing_type schema present"
COL=$($PG -t -A -c "SELECT column_name FROM information_schema.columns WHERE table_name='plans' AND column_name='billing_type';" | tr -d ' ')
CHK=$($PG -t -A -c "SELECT conname FROM pg_constraint WHERE conrelid='plans'::regclass AND conname='plans_billing_type_check';" | tr -d ' ')
if [ "$COL" = "billing_type" ] && [ "$CHK" = "plans_billing_type_check" ]; then ok "column + check constraint present"; else bad "missing: col=$COL chk=$CHK"; fi

# ------------------------------------------------------------------------
# 2. admin POST /admin/plans with billing_type=token_pack
#    → period_days force-clamped to 3650 regardless of input
# ------------------------------------------------------------------------
note "2. admin create token_pack plan (period_days force-clamped to 3650)"
SLUG="dual-pack-$(date +%s%N)"
CRT=$(ch -X POST $B/admin/plans -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Dual Smoke Pack\",\"slug\":\"$SLUG\",\"period_days\":30,\"quota_tokens\":2000,\"price_cents\":500,\"wholesale_face_value_cents\":500,\"billing_type\":\"token_pack\",\"allowed_models\":[\"claude-*\"]}")
PACK_PLAN_ID=$(echo "$CRT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
PACK_PD=$(echo "$CRT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("period_days",""))' 2>/dev/null)
PACK_BT=$(echo "$CRT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("billing_type",""))' 2>/dev/null)
if [ -n "$PACK_PLAN_ID" ] && [ "$PACK_PD" = "3650" ] && [ "$PACK_BT" = "token_pack" ]; then
  ok "POST token_pack: id=$PACK_PLAN_ID period_days=$PACK_PD billing_type=$PACK_BT"
else
  bad "create token_pack failed: id=$PACK_PLAN_ID period_days=$PACK_PD billing_type=$PACK_BT raw=$CRT"
fi

# ------------------------------------------------------------------------
# 3. PATCH same plan with period_days=30 — backend should re-clamp to 3650
#    (because billing_type is still token_pack)
# ------------------------------------------------------------------------
note "3. PATCH token_pack with period_days=30 → still clamped to 3650"
PAT=$(ch -X PATCH $B/admin/plans/$PACK_PLAN_ID -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"billing_type":"token_pack","period_days":30}')
PAT_PD=$(echo "$PAT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("period_days",""))' 2>/dev/null)
if [ "$PAT_PD" = "3650" ]; then ok "PATCH re-clamped period_days=3650"; else bad "PATCH leaked period_days=$PAT_PD: $PAT"; fi

# ------------------------------------------------------------------------
# 4. /storefront/plans returns both flavours
# ------------------------------------------------------------------------
note "4. /storefront/plans returns both billing_type flavours"
PUB=$(ch $B/storefront/plans)
HAS_SUB=$(echo "$PUB" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('data',[]):
  if p.get('billing_type','subscription') == 'subscription':
    print('y'); break
" 2>/dev/null)
HAS_PACK=$(echo "$PUB" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('data',[]):
  if p.get('billing_type') == 'token_pack':
    print('y'); break
" 2>/dev/null)
if [ "$HAS_SUB" = "y" ] && [ "$HAS_PACK" = "y" ]; then ok "/storefront/plans has both flavours"; else bad "missing flavour: sub=$HAS_SUB pack=$HAS_PACK"; fi

# ------------------------------------------------------------------------
# 5. end_user signup + buy SUBSCRIPTION first
# ------------------------------------------------------------------------
note "5. end_user buys subscription (Pro 5M tokens / 30d)"
EMAIL="dual-smoke-$(date +%s%N)@example.com"
SIGNUP=$(ch -X POST $B/storefront/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke12345\"}")
USER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
USER_ID=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user",{}).get("id",""))' 2>/dev/null)
if [ -z "$USER_TOK" ]; then bad "signup failed"; exit 1; fi

# Find a subscription plan
SUB_PLAN_ID=$(echo "$PUB" | python3 -c "
import json,sys
for p in json.load(sys.stdin).get('data',[]):
  if p.get('billing_type','subscription') == 'subscription' and p.get('slug')=='pro':
    print(p['id']); break
" 2>/dev/null)
if [ -z "$SUB_PLAN_ID" ]; then
  # fallback: any subscription plan
  SUB_PLAN_ID=$(echo "$PUB" | python3 -c "
import json,sys
for p in json.load(sys.stdin).get('data',[]):
  if p.get('billing_type','subscription') == 'subscription':
    print(p['id']); break
" 2>/dev/null)
fi
UAUTH="Authorization: Bearer $USER_TOK"
O_SUB=$(ch -X POST $B/storefront/orders -H "$UAUTH" -H 'Content-Type: application/json' -d "{\"plan_id\":$SUB_PLAN_ID}")
O_SUB_ID=$(echo "$O_SUB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
C_SUB=$(ch -X POST $B/storefront/orders/$O_SUB_ID/dev-confirm-paid -H "$UAUTH")
SUB_SUB_ID=$(echo "$C_SUB" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("subscription") or {}).get("id",""))' 2>/dev/null)
SUB_RAW=$(echo "$C_SUB" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_key","") or "")' 2>/dev/null)
if [ -n "$SUB_SUB_ID" ] && [ -n "$SUB_RAW" ]; then ok "subscription provisioned: sub_id=$SUB_SUB_ID"; else bad "sub provision failed: $C_SUB"; fi

# Pin remaining_tokens low so we can drain it quickly in step 8.
$PG -c "UPDATE subscription SET remaining_tokens = 50 WHERE id = $SUB_SUB_ID;" >/dev/null

# ------------------------------------------------------------------------
# 6. same end_user buys TOKEN PACK (idempotency check too)
# ------------------------------------------------------------------------
note "6. same user buys token_pack with idempotency_key"
IDEMP="dual-pack-idemp-$(date +%s%N)"
O_PK1=$(ch -X POST $B/storefront/orders -H "$UAUTH" -H 'Content-Type: application/json' -d "{\"plan_id\":$PACK_PLAN_ID,\"idempotency_key\":\"$IDEMP\"}")
O_PK2=$(ch -X POST $B/storefront/orders -H "$UAUTH" -H 'Content-Type: application/json' -d "{\"plan_id\":$PACK_PLAN_ID,\"idempotency_key\":\"$IDEMP\"}")
PK1_ID=$(echo "$O_PK1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
PK2_ID=$(echo "$O_PK2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
if [ -n "$PK1_ID" ] && [ "$PK1_ID" = "$PK2_ID" ]; then ok "idempotency on token_pack: same order_id=$PK1_ID"; else bad "idempotency mismatch: PK1=$PK1_ID PK2=$PK2_ID"; fi

C_PK=$(ch -X POST $B/storefront/orders/$PK1_ID/dev-confirm-paid -H "$UAUTH")
PK_SUB_ID=$(echo "$C_PK" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("subscription") or {}).get("id",""))' 2>/dev/null)
PK_RAW=$(echo "$C_PK" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("raw_key","") or "")' 2>/dev/null)
if [ -n "$PK_SUB_ID" ] && [ -n "$PK_RAW" ]; then
  ok "token_pack provisioned: sub_id=$PK_SUB_ID (3650d expiry, 2K tokens)"
else
  bad "pack provision failed: $C_PK"
fi

# Verify two active subscriptions exist for this user
SUB_COUNT=$($PG -t -A -c "SELECT COUNT(*) FROM subscription WHERE end_user_id=$USER_ID AND status='active';" | tr -d ' ')
if [ "$SUB_COUNT" = "2" ]; then ok "user has 2 active subs (1 sub + 1 pack)"; else bad "expected 2 active subs, got $SUB_COUNT"; fi

# ------------------------------------------------------------------------
# 7. /storefront/balance returns 3 numbers
# ------------------------------------------------------------------------
note "7. /storefront/balance returns subscription + pack + total"
BAL=$(ch $B/storefront/balance -H "$UAUTH")
B_SUB=$(echo "$BAL" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("subscription_tokens",-1))' 2>/dev/null)
B_PACK=$(echo "$BAL" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token_pack_tokens",-1))' 2>/dev/null)
B_TOT=$(echo "$BAL" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total",-1))' 2>/dev/null)
SUM=$((B_SUB + B_PACK))
if [ "$B_SUB" -gt 0 ] 2>/dev/null && [ "$B_PACK" -gt 0 ] 2>/dev/null && [ "$B_TOT" = "$SUM" ]; then
  ok "balance: sub=$B_SUB pack=$B_PACK total=$B_TOT (=$SUM)"
else
  bad "balance malformed: sub=$B_SUB pack=$B_PACK total=$B_TOT (sum=$SUM) raw=$BAL"
fi

# ------------------------------------------------------------------------
# 8. /v1/messages debits subscription first (oldest-expires-first FIFO)
#    Use the SUBSCRIPTION-bound sk-key so we exercise the cross-sub debit
#    path (token bound to sub, but logical balance spans both).
# ------------------------------------------------------------------------
note "8. /v1/messages drains subscription before token_pack (FIFO by expires)"
BEFORE_SUB=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$SUB_SUB_ID;" | tr -d ' ')
BEFORE_PACK=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$PK_SUB_ID;" | tr -d ' ')

# Call /v1/messages enough times to guarantee the subscription (50 tokens)
# drains and overflow lands on the pack. Mock returns ~16 tokens/call so 10
# calls cover both "sub still draining" and "sub=0, pack absorbing overflow".
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sS -m 10 -H "$HOST_HDR" -X POST $B/v1/messages \
    -H "Authorization: Bearer $SUB_RAW" -H 'Content-Type: application/json' \
    -d '{"model":"claude-sonnet-4-7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}' >/dev/null
done

AFTER_SUB=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$SUB_SUB_ID;" | tr -d ' ')
AFTER_PACK=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$PK_SUB_ID;" | tr -d ' ')
SUB_DROP=$((BEFORE_SUB - AFTER_SUB))
PACK_DROP=$((BEFORE_PACK - AFTER_PACK))

echo "  before: sub=$BEFORE_SUB pack=$BEFORE_PACK"
echo "  after : sub=$AFTER_SUB pack=$AFTER_PACK"
echo "  drops : sub=-$SUB_DROP pack=-$PACK_DROP"
# FIFO: subscription (~30d expiry) must drain BEFORE token_pack (3650d).
# We accept either of:
#   a) sub=0 + pack started bleeding (full FIFO crossover)
#   b) sub>0 + pack untouched     (sub still has runway, FIFO still holds)
# We reject the wrong direction: pack debited while sub still positive.
if [ "$AFTER_SUB" -gt 0 ] 2>/dev/null && [ "$PACK_DROP" = "0" ]; then
  ok "FIFO holds: sub still draining ($SUB_DROP debited), pack untouched"
elif [ "$AFTER_SUB" = "0" ] && [ "$PACK_DROP" -gt 0 ] 2>/dev/null; then
  ok "FIFO crossover: subscription drained to 0; pack absorbed overflow"
else
  bad "FIFO ordering broken: after_sub=$AFTER_SUB pack_drop=$PACK_DROP (sub should drain BEFORE pack)"
fi

# ------------------------------------------------------------------------
# 9. /v1/messages still 200 when subscription empty + pack still has tokens
# ------------------------------------------------------------------------
note "9. /v1/messages 200 when sub=0 but pack>0"
# Sanity: subscription is 0, pack should still be >0 at this point.
CUR_PACK=$($PG -t -A -c "SELECT remaining_tokens FROM subscription WHERE id=$PK_SUB_ID;" | tr -d ' ')
if [ "$CUR_PACK" -le 0 ] 2>/dev/null; then
  bad "step 9 setup: pack already drained (=$CUR_PACK); cannot verify"
else
  MSG9=$(curl -sS -m 10 -H "$HOST_HDR" -w '\n__HTTP:%{http_code}' -X POST $B/v1/messages \
    -H "Authorization: Bearer $SUB_RAW" -H 'Content-Type: application/json' \
    -d '{"model":"claude-sonnet-4-7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
  H9=$(http_of "$MSG9")
  if [ "$H9" = "200" ]; then ok "HTTP 200 with sub=0 / pack=$CUR_PACK"; else bad "expected 200, got $H9 body=$(body_of "$MSG9")"; fi
fi

# ------------------------------------------------------------------------
# 10. Drain pack to 0 → /v1/messages returns 402 insufficient_quota
# ------------------------------------------------------------------------
note "10. drain pack → 402 insufficient_quota"
$PG -c "UPDATE subscription SET remaining_tokens = 0 WHERE end_user_id=$USER_ID;" >/dev/null
MSG10=$(curl -sS -m 10 -H "$HOST_HDR" -w '\n__HTTP:%{http_code}' -X POST $B/v1/messages \
  -H "Authorization: Bearer $SUB_RAW" -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}')
H10=$(http_of "$MSG10")
ERR_TYPE=$(body_of "$MSG10" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",{}).get("type",""))' 2>/dev/null)
if [ "$H10" = "402" ] && [ "$ERR_TYPE" = "insufficient_quota" ]; then
  ok "402 insufficient_quota when both sub + pack at 0"
else
  bad "expected 402 insufficient_quota, got HTTP=$H10 type=$ERR_TYPE body=$(body_of "$MSG10")"
fi

# ------------------------------------------------------------------------
# 11. Top up token_pack (simulate user buying another pack) — balance grows
# ------------------------------------------------------------------------
note "11. user buys 2nd token_pack → balance accumulates"
O_PK3=$(ch -X POST $B/storefront/orders -H "$UAUTH" -H 'Content-Type: application/json' -d "{\"plan_id\":$PACK_PLAN_ID}")
O_PK3_ID=$(echo "$O_PK3" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("order",{}).get("id",""))' 2>/dev/null)
ch -X POST $B/storefront/orders/$O_PK3_ID/dev-confirm-paid -H "$UAUTH" >/dev/null
ACTIVE_AFTER=$($PG -t -A -c "SELECT COUNT(*) FROM subscription WHERE end_user_id=$USER_ID AND status='active' AND remaining_tokens > 0;" | tr -d ' ')
BAL2=$(ch $B/storefront/balance -H "$UAUTH")
B2_PACK=$(echo "$BAL2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token_pack_tokens",-1))' 2>/dev/null)
if [ "$ACTIVE_AFTER" -ge 1 ] 2>/dev/null && [ "$B2_PACK" -ge 2000 ] 2>/dev/null; then
  ok "2nd pack stacked: active_w_tokens=$ACTIVE_AFTER token_pack_balance=$B2_PACK"
else
  bad "2nd pack stack failed: active=$ACTIVE_AFTER pack_bal=$B2_PACK"
fi

# ------------------------------------------------------------------------
# 12. /storefront/subscriptions exposes billing_type per row
# ------------------------------------------------------------------------
note "12. /storefront/subscriptions exposes billing_type per row"
SLIST=$(ch $B/storefront/subscriptions -H "$UAUTH")
HAS_SUB_BT=$(echo "$SLIST" | python3 -c "
import json,sys
for r in json.load(sys.stdin).get('data',[]):
  if r.get('billing_type') == 'subscription':
    print('y'); break
" 2>/dev/null)
HAS_PACK_BT=$(echo "$SLIST" | python3 -c "
import json,sys
for r in json.load(sys.stdin).get('data',[]):
  if r.get('billing_type') == 'token_pack':
    print('y'); break
" 2>/dev/null)
if [ "$HAS_SUB_BT" = "y" ] && [ "$HAS_PACK_BT" = "y" ]; then
  ok "subscriptions list shows both billing_type values"
else
  bad "billing_type missing in /storefront/subscriptions: sub=$HAS_SUB_BT pack=$HAS_PACK_BT"
fi

# ------------------------------------------------------------------------
# cleanup: hard-delete the test pack plan if it has no orders referencing
# it (it does, so it'll soft-disable instead — that's fine).
# ------------------------------------------------------------------------
ch -X DELETE $B/admin/plans/$PACK_PLAN_ID -H "$AUTH" >/dev/null 2>&1

echo ""
echo "==========================================="
echo "  v0.3 dual-billing smoke: PASS=$PASS FAIL=$FAIL"
echo "==========================================="
[ "$FAIL" = "0" ]
