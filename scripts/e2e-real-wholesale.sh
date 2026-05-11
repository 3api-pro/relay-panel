#!/usr/bin/env bash
# End-to-end test: 3api panel → llmapi prod (real wsk-* + real sk-relay-* → Claude).
#
# Steps:
#   1. Provision a fresh tenant via /signup-tenant
#   2. Login as the new tenant admin
#   3. Top up that tenant's local wholesale_balance to ¥100 (DB UPDATE) + purchase
#      a real shadow sk-relay-* on llmapi using the wsk- key, install it as
#      the tenant's default upstream_channel
#   4. Sign up an end-user on storefront (Host: <slug>.3api.pro)
#   5. Create order for plan "pro"
#   6. dev-confirm-paid (returns raw panel-issued sk-relay-* key)
#   7. POST /v1/messages with that panel key → panel forwards to llmapi prod
#      using the shadow sk- → llmapi calls Claude → content returned

set -euo pipefail
BASE=${BASE:-http://127.0.0.1:3199}
SAAS=${SAAS:-3api.pro}
STAMP=$(date +%s)
SLUG="e2e${STAMP}"
ADMIN_EMAIL="e2e-admin-${STAMP}@test.local"
ADMIN_PW="e2e-admin-pwd-1234"
EU_EMAIL="e2e-user-${STAMP}@test.local"
EU_PW="e2e-user-pwd-1234"
HOST_HDR="${SLUG}.${SAAS}"

step()  { echo; echo "==== $* ===="; }
fail()  { echo "FAIL: $*"; exit 1; }
have()  { command -v "$1" >/dev/null 2>&1 || fail "missing tool: $1"; }
have curl
have jq

PASS_COUNT=0
TOTAL=8

step "[1/$TOTAL] /signup-tenant slug=$SLUG"
R1=$(curl -fsS -X POST "$BASE/signup-tenant" \
  -H "Content-Type: application/json" \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"$ADMIN_EMAIL\",\"admin_password\":\"$ADMIN_PW\"}")
echo "$R1" | jq -e '.tenant.id and .tenant.slug' >/dev/null
TENANT_ID=$(echo "$R1" | jq -r .tenant.id)
echo "  ok tenant_id=$TENANT_ID"
PASS_COUNT=$((PASS_COUNT+1))

step "[2/$TOTAL] admin /login"
R2=$(curl -fsS -X POST "$BASE/admin/login" \
  -H "Host: $HOST_HDR" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")
ADMIN_TOKEN=$(echo "$R2" | jq -r .token)
[ -n "$ADMIN_TOKEN" ] && [ "$ADMIN_TOKEN" != "null" ] || fail "no admin token: $R2"
echo "  ok admin_token=${ADMIN_TOKEN:0:24}…"
PASS_COUNT=$((PASS_COUNT+1))

step "[3/$TOTAL] top up wholesale_balance + purchase shadow sk- + install upstream_channel"
docker exec postgres psql -U admin -d relay_panel_3api -c \
  "UPDATE wholesale_balance SET balance_cents = 10000, updated_at = NOW() WHERE tenant_id = $TENANT_ID" \
  | grep -E "UPDATE [1-9]" >/dev/null || fail "wholesale_balance UPDATE missed rows"

WSK=$(cat /root/.3api-wholesale-key)
REQ_ID="e2e-${SLUG}-bootstrap"
PUR=$(curl -fsS -X POST http://127.0.0.1:3103/v1/wholesale/purchase \
  -H "Authorization: Bearer $WSK" \
  -H "Content-Type: application/json" \
  -d "{\"plan\":\"pro\",\"cycle\":\"monthly\",\"request_id\":\"$REQ_ID\"}")
SHADOW_SK=$(echo "$PUR" | jq -r .api_key)
[ -n "$SHADOW_SK" ] && [ "$SHADOW_SK" != "null" ] || fail "purchase failed: $PUR"
echo "  ok shadow_sk=${SHADOW_SK:0:18}…"

docker exec postgres psql -U admin -d relay_panel_3api -c "
  INSERT INTO upstream_channel (tenant_id, name, base_url, api_key, type, status, is_default, priority, weight)
  VALUES ($TENANT_ID, 'llmapi-prod', 'http://127.0.0.1:3103/v1', '$SHADOW_SK', 'wholesale-3api', 'active', true, 100, 100);
" | grep -E "INSERT [0-9]+ 1" >/dev/null || fail "upstream_channel insert failed"
echo "  ok upstream_channel installed"
PASS_COUNT=$((PASS_COUNT+1))

step "[4/$TOTAL] /storefront/auth/signup (Host: $HOST_HDR)"
R4=$(curl -fsS -X POST "$BASE/storefront/auth/signup" \
  -H "Host: $HOST_HDR" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EU_EMAIL\",\"password\":\"$EU_PW\"}")
EU_TOKEN=$(echo "$R4" | jq -r .token)
[ -n "$EU_TOKEN" ] && [ "$EU_TOKEN" != "null" ] || fail "no end_user token: $R4"
echo "  ok end_user_token=${EU_TOKEN:0:24}…"
PASS_COUNT=$((PASS_COUNT+1))

step "[5/$TOTAL] /storefront/plans → pick a plan_id"
R5=$(curl -fsS "$BASE/storefront/plans" -H "Host: $HOST_HDR")
PLAN_ID=$(echo "$R5" | jq -r '.data[] | select(.slug=="pro") | .id')
[ -n "$PLAN_ID" ] && [ "$PLAN_ID" != "null" ] || fail "no pro plan: $R5"
echo "  ok plan_id=$PLAN_ID (slug=pro)"
PASS_COUNT=$((PASS_COUNT+1))

step "[6/$TOTAL] /storefront/orders POST"
IDEMP=$(cat /proc/sys/kernel/random/uuid)
R6=$(curl -fsS -X POST "$BASE/storefront/orders" \
  -H "Host: $HOST_HDR" \
  -H "Authorization: Bearer $EU_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"plan_id\":$PLAN_ID,\"idempotency_key\":\"$IDEMP\"}")
ORDER_ID=$(echo "$R6" | jq -r .order.id)
[ -n "$ORDER_ID" ] && [ "$ORDER_ID" != "null" ] || fail "no order id: $R6"
echo "  ok order_id=$ORDER_ID"
PASS_COUNT=$((PASS_COUNT+1))

step "[7/$TOTAL] /storefront/orders/$ORDER_ID/dev-confirm-paid"
R7=$(curl -fsS -X POST "$BASE/storefront/orders/$ORDER_ID/dev-confirm-paid" \
  -H "Host: $HOST_HDR" \
  -H "Authorization: Bearer $EU_TOKEN")
SK=$(echo "$R7" | jq -r .raw_key)
[ -n "$SK" ] && [ "$SK" != "null" ] || fail "no raw_key: $R7"
echo "  ok sk=${SK:0:18}…"
PASS_COUNT=$((PASS_COUNT+1))

step "[8/$TOTAL] /v1/messages with sk-relay-* (real call to Claude via llmapi prod)"
R8=$(curl -sS -X POST "$BASE/v1/messages" \
  -H "Host: $HOST_HDR" \
  -H "Authorization: Bearer $SK" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":32,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}')
echo "  upstream response: $(echo "$R8" | head -c 400)"
echo "$R8" | jq -e '[.content[] | select(.type=="text") | .text] | join("") | length > 0' >/dev/null || fail "no text content from Claude: $R8"
TXT=$(echo "$R8" | jq -r '[.content[] | select(.type=="text") | .text] | join("")')
echo "  ok Claude returned text: $(echo "$TXT" | head -c 200)"
PASS_COUNT=$((PASS_COUNT+1))

echo
echo "============================================"
echo " E2E PASS: $PASS_COUNT/$TOTAL steps"
echo " tenant=$SLUG order=$ORDER_ID sk_prefix=${SK:0:18}"
echo "============================================"
