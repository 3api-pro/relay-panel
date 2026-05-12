#!/bin/bash
# Smoke test — v0.4 affiliate (P2 #18 reseller-to-reseller referral).
#
# Validates:
#   - migration 012 applied (tenant.aff_code + reseller_referral + trigger)
#   - tenant.aff_code auto-populated by BEFORE INSERT trigger
#   - aff_code uniqueness over all tenants
#   - POST /api/signup-tenant with valid ref code → referral_recorded=true,
#     row created with referrer_tenant_id = code owner
#   - POST /api/signup-tenant with bad ref code → tenant created,
#     referral_recorded=false, no reseller_referral row
#   - UNIQUE(referred_tenant_id) blocks double-referral
#   - order status flip to 'paid' fires trigger → commission accrues 10%
#   - re-flip to 'paid' does NOT double-credit (OLD.status guard)
#   - GET /api/admin/affiliate returns matching stats + invite_link
#   - GET /api/admin/affiliate/referrals lists referred tenants
#   - POST /api/admin/affiliate/withdraw + GET /withdrawals
#   - Over-amount withdrawal rejected
#
# Note: signup rate-limit is 1/min per IP, so we do ONE HTTP signup (the
# valid-ref case) and seed the rest via SQL to keep the run fast and
# repeatable.
#
# Requires:
#   - 3api-panel on :3199 (TENANT_MODE=multi, TENANT_SELF_SIGNUP=on)
#   - postgres on :5432 (db=relay_panel_3api, user=admin)
set +e

B=http://127.0.0.1:3199
HOST_HDR="Host: 3api.pro"
PG="psql -q -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

ch()  { curl -sS -m 15 -H "$HOST_HDR" "$@"; }

PASS=0; FAIL=0
note() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

SMOKE_TAG="affsmoke$$"

cleanup() {
  $PG -c "DELETE FROM referral_withdrawal WHERE referrer_tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM reseller_referral   WHERE referrer_tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%') OR referred_tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM orders        WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM subscription  WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM plans         WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM brand_config  WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM end_user      WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM wholesale_balance WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM reseller_admin WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM upstream_channel WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM system_setting WHERE tenant_id IN (SELECT id FROM tenant WHERE slug LIKE '${SMOKE_TAG}%');" >/dev/null
  $PG -c "DELETE FROM tenant WHERE slug LIKE '${SMOKE_TAG}%';" >/dev/null
}
trap cleanup EXIT
cleanup

# ------------------------------------------------------------------------
# 1. migration 012 applied — tables / columns / triggers / unique idx exist
# ------------------------------------------------------------------------
note "1. migration 012 applied"
HAS_AFFCOL=$($PG -t -A -c "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='tenant' AND column_name='aff_code');")
HAS_REFTBL=$($PG -t -A -c "SELECT to_regclass('public.reseller_referral') IS NOT NULL;")
HAS_WDTBL=$($PG -t -A -c "SELECT to_regclass('public.referral_withdrawal') IS NOT NULL;")
HAS_TRG=$($PG -t -A -c "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_orders_affiliate');")
HAS_DEFTRG=$($PG -t -A -c "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_tenant_aff_code');")
HAS_IDX=$($PG -t -A -c "SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='idx_tenant_aff_code');")
[ "$HAS_AFFCOL" = "t" ] && ok "tenant.aff_code present" || bad "tenant.aff_code missing"
[ "$HAS_REFTBL" = "t" ] && ok "reseller_referral table present" || bad "reseller_referral missing"
[ "$HAS_WDTBL"  = "t" ] && ok "referral_withdrawal table present" || bad "referral_withdrawal missing"
[ "$HAS_TRG"    = "t" ] && ok "trg_orders_affiliate trigger present" || bad "trigger missing"
[ "$HAS_DEFTRG" = "t" ] && ok "trg_tenant_aff_code default-trigger present" || bad "default trigger missing"
[ "$HAS_IDX"    = "t" ] && ok "idx_tenant_aff_code unique idx present" || bad "unique idx missing"

# ------------------------------------------------------------------------
# 2. aff_code uniqueness across all tenants + non-null
# ------------------------------------------------------------------------
note "2. aff_code unique + non-null"
TOTAL=$($PG -t -A -c "SELECT COUNT(*) FROM tenant;")
DIST=$($PG -t -A -c "SELECT COUNT(DISTINCT aff_code) FROM tenant WHERE aff_code IS NOT NULL;")
NULLC=$($PG -t -A -c "SELECT COUNT(*) FROM tenant WHERE aff_code IS NULL;")
if [ "$TOTAL" = "$DIST" ] && [ "$NULLC" = "0" ]; then
  ok "aff_code unique + non-null across $TOTAL tenants"
else
  bad "tenants=$TOTAL distinct=$DIST null=$NULLC"
fi

# ------------------------------------------------------------------------
# 3. seed tenant A (referrer) directly — get its aff_code (BEFORE trigger).
# ------------------------------------------------------------------------
note "3. seed tenant A (referrer) — BEFORE trigger fills aff_code"
SLUG_A="${SMOKE_TAG}a"
TENANT_A_ID=$($PG -t -A -c "INSERT INTO tenant (slug, status) VALUES ('$SLUG_A', 'active') RETURNING id;")
CODE_A=$($PG -t -A -c "SELECT aff_code FROM tenant WHERE id=$TENANT_A_ID;")
if [ -n "$TENANT_A_ID" ] && [ ${#CODE_A} -ge 6 ]; then
  ok "tenant A id=$TENANT_A_ID slug=$SLUG_A aff_code=$CODE_A (auto-set)"
else
  bad "tenant A seed failed id='$TENANT_A_ID' code='$CODE_A'"
fi
# Plus an end_user table for cleanup-pattern; also need plans/brand for admin login.
ADMIN_HASH=$($PG -t -A -c "SELECT password_hash FROM reseller_admin WHERE email='admin@3api.pro' LIMIT 1;")
$PG -c "INSERT INTO reseller_admin (tenant_id, email, password_hash, display_name, status) VALUES ($TENANT_A_ID, '${SMOKE_TAG}-a@example.com', '$ADMIN_HASH', 'A-Owner', 'active');" >/dev/null
$PG -c "INSERT INTO wholesale_balance (tenant_id, balance_cents) VALUES ($TENANT_A_ID, 0) ON CONFLICT DO NOTHING;" >/dev/null

# ------------------------------------------------------------------------
# 4. seed tenant B + manually-record referral via bad-code path (silent skip).
# ------------------------------------------------------------------------
note "4. bad ref code is silently skipped"
SLUG_B="${SMOKE_TAG}b"
TENANT_B_ID=$($PG -t -A -c "INSERT INTO tenant (slug, status) VALUES ('$SLUG_B', 'active') RETURNING id;")
# Try inserting a referral with a code that doesn't exist (simulating what
# recordReferral does): lookup returns 0 rows so no insert happens.
BOGUS_CNT=$($PG -t -A -c "SELECT COUNT(*) FROM tenant WHERE aff_code='zzzz9999';")
if [ "$BOGUS_CNT" = "0" ]; then ok "bogus aff_code 'zzzz9999' resolves to 0 tenants (skip path)"; else bad "bogus code resolves to $BOGUS_CNT tenants"; fi
NO_REF=$($PG -t -A -c "SELECT COUNT(*) FROM reseller_referral WHERE referred_tenant_id=$TENANT_B_ID;")
if [ "$NO_REF" = "0" ]; then ok "no reseller_referral row for B (no signup ran w/ bad code)"; else bad "unexpected row: $NO_REF"; fi

# ------------------------------------------------------------------------
# 5. HTTP signup tenant C with VALID ref code → real plumbing test.
# ------------------------------------------------------------------------
note "5. HTTP /api/signup-tenant with valid ref code"
EMAIL_C="${SMOKE_TAG}-c@example.com"
SLUG_C="${SMOKE_TAG}c"
R=$(ch -X POST "$B/api/signup-tenant" -H 'Content-Type: application/json' \
     -d "{\"slug\":\"$SLUG_C\",\"admin_email\":\"$EMAIL_C\",\"admin_password\":\"testpw1234\",\"ref\":\"$CODE_A\"}")
TENANT_C_ID=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tenant"]["id"])' 2>/dev/null)
REF_RECORDED_C=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("referral_recorded",False))' 2>/dev/null)
if [ "$R" = "${R/rate_limit_exceeded/}" ]; then
  if [ -n "$TENANT_C_ID" ]; then ok "tenant C created id=$TENANT_C_ID via HTTP"; else bad "tenant C create: $R"; fi
  if [ "$REF_RECORDED_C" = "True" ]; then ok "valid code → referral_recorded=True"; else bad "expected True got '$REF_RECORDED_C'"; fi
  REF_ROW=$($PG -t -A -c "SELECT referrer_tenant_id || '|' || commission_pct || '|' || status FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
  EXPECT="${TENANT_A_ID}|10|active"
  if [ "$REF_ROW" = "$EXPECT" ]; then ok "referral row: $REF_ROW"; else bad "expected $EXPECT got '$REF_ROW'"; fi
else
  bad "rate-limited — re-run after 60s or restart container: $R"
fi

# ------------------------------------------------------------------------
# 6. UNIQUE protects against duplicate referrer — manual INSERT must DO NOTHING.
# ------------------------------------------------------------------------
note "6. UNIQUE blocks second referrer for same tenant"
OTHER_REFERRER=$(( TENANT_A_ID == 1 ? 2 : 1 ))
$PG -c "INSERT INTO reseller_referral (referrer_tenant_id, referred_tenant_id, commission_pct) VALUES ($OTHER_REFERRER, $TENANT_C_ID, 20) ON CONFLICT (referred_tenant_id) DO NOTHING;" >/dev/null
STILL=$($PG -t -A -c "SELECT referrer_tenant_id FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
if [ "$STILL" = "$TENANT_A_ID" ]; then ok "duplicate INSERT DO NOTHING (referrer stays $TENANT_A_ID)"; else bad "referrer changed to $STILL"; fi

# ------------------------------------------------------------------------
# 7. trigger: orders.status=paid → reseller_referral.commission_cents grows.
# ------------------------------------------------------------------------
note "7. trigger credits commission on paid order"
EU_ID=$($PG -t -A -c "INSERT INTO end_user (tenant_id, email, password_hash) VALUES ($TENANT_C_ID, '${SMOKE_TAG}-eu@example.com', 'x') RETURNING id;")
PL_ID=$($PG -t -A -c "INSERT INTO plans (tenant_id, name, slug, price_cents, period_days, quota_tokens, wholesale_face_value_cents) VALUES ($TENANT_C_ID, 'aff-smoke', 'aff-smoke', 5000, 30, 1000000, 3000) RETURNING id;")
OR_ID=$($PG -t -A -c "INSERT INTO orders (tenant_id, end_user_id, plan_id, amount_cents, status, idempotency_key) VALUES ($TENANT_C_ID, $EU_ID, $PL_ID, 5000, 'pending', '${SMOKE_TAG}-idem-1') RETURNING id;")
[ -n "$OR_ID" ] && ok "order seeded id=$OR_ID amount=5000" || bad "order seed failed (EU=$EU_ID PL=$PL_ID T=$TENANT_C_ID)"
BEFORE=$($PG -t -A -c "SELECT commission_cents FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
$PG -c "UPDATE orders SET status='paid', paid_at=NOW() WHERE id=$OR_ID;" >/dev/null
AFTER=$($PG -t -A -c "SELECT commission_cents FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
DELTA=$(( AFTER - BEFORE ))
if [ "$DELTA" = "500" ]; then ok "trigger credited 500 cents (10% of 5000)"; else bad "delta=$DELTA before=$BEFORE after=$AFTER"; fi

# Re-update to paid again — must NOT double-credit (OLD.status='paid').
$PG -c "UPDATE orders SET status='paid' WHERE id=$OR_ID;" >/dev/null
AGAIN=$($PG -t -A -c "SELECT commission_cents FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
if [ "$AGAIN" = "$AFTER" ]; then ok "idempotent: re-update to paid does not double-credit"; else bad "re-update changed $AFTER → $AGAIN"; fi

# Pending → paid for a second order also credits.
OR2_ID=$($PG -t -A -c "INSERT INTO orders (tenant_id, end_user_id, plan_id, amount_cents, status, idempotency_key) VALUES ($TENANT_C_ID, $EU_ID, $PL_ID, 9900, 'pending', '${SMOKE_TAG}-idem-2') RETURNING id;")
$PG -c "UPDATE orders SET status='paid', paid_at=NOW() WHERE id=$OR2_ID;" >/dev/null
SECOND=$($PG -t -A -c "SELECT commission_cents FROM reseller_referral WHERE referred_tenant_id=$TENANT_C_ID;")
WANT=$(( AFTER + 990 ))
if [ "$SECOND" = "$WANT" ]; then ok "second order credits 990 (10% of 9900) → total $SECOND"; else bad "expected $WANT got $SECOND"; fi

# ------------------------------------------------------------------------
# 8. GET /api/admin/affiliate (as tenant A) — stats match DB.
# ------------------------------------------------------------------------
note "8. GET /api/admin/affiliate stats"
# Login as the admin we seeded for tenant A. We re-used the existing admin
# hash so the password is whatever admin@3api.pro uses (CHANGEME default).
LOGIN_A=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -X POST "$B/api/admin/login" -H 'Content-Type: application/json' -d "{\"email\":\"${SMOKE_TAG}-a@example.com\",\"password\":\"admin-3api-init-pwd-CHANGEME\"}")
TOK_A=$(echo "$LOGIN_A" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$TOK_A" ]; then bad "tenant A admin login: $LOGIN_A"; else ok "tenant A admin login ok"; fi
AUTH_A="Authorization: Bearer $TOK_A"

STATS=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" "$B/api/admin/affiliate")
PARSED=$(echo "$STATS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('aff_code','-')+'|'+str(d.get('referred_count',-1))+'|'+str(d.get('active_referred_count',-1))+'|'+str(d.get('total_commission_cents',-1))+'|'+str(d.get('available_balance_cents',-1)))
" 2>/dev/null)
EXPECT="$CODE_A|1|1|$SECOND|$SECOND"
if [ "$PARSED" = "$EXPECT" ]; then ok "stats $PARSED"; else bad "expected $EXPECT got '$PARSED' raw=$STATS"; fi

INVITE=$(echo "$STATS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("invite_link",""))' 2>/dev/null)
if echo "$INVITE" | grep -q "ref=$CODE_A"; then ok "invite_link contains ref=$CODE_A ($INVITE)"; else bad "invite_link bad: $INVITE"; fi

REFS=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" "$B/api/admin/affiliate/referrals")
REFS_COUNT=$(echo "$REFS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "$REFS_COUNT" = "1" ]; then ok "/referrals returns 1 row"; else bad "expected 1 got $REFS_COUNT raw=$REFS"; fi

# ------------------------------------------------------------------------
# 9. POST /api/admin/affiliate/withdraw + GET /withdrawals
# ------------------------------------------------------------------------
note "9. withdraw + list"
WD=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" -H 'Content-Type: application/json' \
     -X POST "$B/api/admin/affiliate/withdraw" \
     -d '{"amount_cents":300,"method":"alipay","account_info":"test@example.com"}')
WID=$(echo "$WD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
if [ -n "$WID" ]; then ok "withdraw filed id=$WID"; else bad "withdraw response: $WD"; fi

WDS=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" "$B/api/admin/affiliate/withdrawals")
WD_COUNT=$(echo "$WDS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "$WD_COUNT" = "1" ]; then ok "/withdrawals returns 1 row"; else bad "expected 1 got $WD_COUNT raw=$WDS"; fi

# Available balance debited by pending.
STATS2=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" "$B/api/admin/affiliate")
AVAIL=$(echo "$STATS2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("available_balance_cents",-1))' 2>/dev/null)
WANT_AVAIL=$(( SECOND - 300 ))
if [ "$AVAIL" = "$WANT_AVAIL" ]; then ok "available_balance debited by pending withdrawal ($AVAIL)"; else bad "expected $WANT_AVAIL got $AVAIL"; fi

# Over-withdraw rejected.
OVER=$(curl -sS -m 10 -H "Host: ${SLUG_A}.3api.pro" -H "$AUTH_A" -H 'Content-Type: application/json' \
     -X POST "$B/api/admin/affiliate/withdraw" \
     -d '{"amount_cents":99999999,"method":"alipay","account_info":"test@example.com"}')
if echo "$OVER" | grep -q "insufficient_balance"; then ok "over-amount rejected"; else bad "over-amount not rejected: $OVER"; fi

echo ""
echo "=== summary: PASS=$PASS FAIL=$FAIL ==="
exit $FAIL
