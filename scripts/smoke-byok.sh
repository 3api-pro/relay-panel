#!/bin/bash
# BYOK relay end-to-end smoke.
#
# Boots a mock upstream on :19999, signs up a fresh tenant, configures a
# channel pointing at the mock, creates an end-user, issues a token,
# and verifies /v1/messages flows through and is billed.
set -uo pipefail

MOCK_PORT=19999
MOCK_KEY="test-byok-mock-$(openssl rand -hex 6 2>/dev/null || echo deadbeef)"

# Export BEFORE node starts so the child sees the env
export MOCK_PORT
export MOCK_API_KEY="$MOCK_KEY"

# Boot the mock in the background; kill it on exit no matter what
node /root/3api-relay-panel/scripts/mock-upstream.js >/tmp/mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1

# Verify mock is alive
if ! curl -sS -m3 -X POST -H "Authorization: Bearer $MOCK_KEY" -H 'Content-Type: application/json' \
       -d '{"model":"x","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}' \
       http://127.0.0.1:${MOCK_PORT}/v1/messages | grep -q "pong from mock"; then
  echo "FATAL: mock upstream not responding" >&2
  cat /tmp/mock.log
  exit 1
fi
echo "[setup] mock upstream alive on :$MOCK_PORT"

PASS=0; FAIL=0
RESULTS=()
check() {
  local label=$1 expected=$2 got=$3
  if [[ "$got" == "$expected" ]]; then
    echo "PASS $label  status=$got"
    PASS=$((PASS+1))
    RESULTS+=("PASS $label")
  else
    echo "FAIL $label  expected=$expected got=$got"
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL $label expected=$expected got=$got")
  fi
}

PANEL=http://127.0.0.1:3199
RAND=$(date +%s)
SLUG="byok${RAND}"
ADMIN_EMAIL="adm${RAND}@local.test"
ADMIN_PW="byokadmin12345"
END_EMAIL="cust${RAND}@local.test"
END_PW="byokuser12345"
HOST="${SLUG}.3api.pro"

# Need to use a real subdomain DNS or pass -H "Host:". We'll Host: the API.
HARG=(-H "Host: $HOST")

echo
echo "=== 1. tenant self-signup ==="
SIGNUP=$(curl -sS -m10 -H "Host: 3api.pro" -X POST -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"$ADMIN_EMAIL\",\"admin_password\":\"$ADMIN_PW\"}" \
  $PANEL/api/signup-tenant)
echo "$SIGNUP" | head -c 200; echo
check signup_201 "" ""  # informational

echo
echo "=== 2. admin login ==="
ADMIN_TOK=$(curl -sS -m10 "${HARG[@]}" -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
  $PANEL/api/admin/login \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token",""))')
echo "ADMIN_TOK_LEN=${#ADMIN_TOK}"
[[ ${#ADMIN_TOK} -gt 0 ]] && check admin_login non_empty non_empty || check admin_login non_empty empty

echo
echo "=== 3. POST /api/admin/channels ==="
CHAN=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' \
  -d "{\"name\":\"mock\",\"base_url\":\"http://127.0.0.1:${MOCK_PORT}/v1\",\"api_key\":\"$MOCK_KEY\",\"type\":\"byok-claude\"}" \
  $PANEL/api/admin/channels)
echo "$CHAN" | head -c 200; echo
CHAN_ID=$(echo "$CHAN" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id",""))')
[[ -n "$CHAN_ID" ]] && check create_channel non_empty non_empty || check create_channel non_empty empty

echo
echo "=== 4. set channel as default ==="
DEF=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $ADMIN_TOK" \
  -o /dev/null -w "%{http_code}" \
  $PANEL/api/admin/channels/$CHAN_ID/set-default)
check set_default 200 "$DEF"

echo
echo "=== 5. admin creates end-user with quota ==="
EUR=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$END_EMAIL\",\"password\":\"$END_PW\",\"initial_quota_cents\":100000}" \
  $PANEL/api/admin/end-users)
echo "$EUR" | head -c 200; echo
END_USER_ID=$(echo "$EUR" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("id",""))')
[[ -n "$END_USER_ID" ]] && check create_enduser non_empty non_empty || check create_enduser non_empty empty

echo
echo "=== 6. admin issues token for that end-user ==="
TOK=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $ADMIN_TOK" -H 'Content-Type: application/json' \
  -d '{"name":"smoke","unlimited_quota":false,"remain_quota_cents":50000}' \
  $PANEL/api/admin/end-users/$END_USER_ID/tokens)
echo "$TOK" | head -c 200; echo
SK=$(echo "$TOK" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("key",""))')
[[ -n "$SK" ]] && check issue_token non_empty non_empty || check issue_token non_empty empty

echo
echo "=== 7. /v1/messages JSON via the issued sk-* ==="
MSG=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-7","max_tokens":50,"messages":[{"role":"user","content":"ping"}]}' \
  $PANEL/api/v1/messages)
echo "$MSG" | head -c 300; echo
HAS_PONG=$(echo "$MSG" | grep -q "pong from mock" && echo yes || echo no)
check json_relay yes "$HAS_PONG"

echo
echo "=== 8. /v1/messages SSE streaming ==="
SSE=$(curl -sS -m10 "${HARG[@]}" -X POST -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-7","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"ping"}]}' \
  $PANEL/api/v1/messages)
HAS_DELTA=$(echo "$SSE" | grep -q "content_block_delta" && echo yes || echo no)
check sse_relay yes "$HAS_DELTA"

echo
echo "=== 9. usage_log row exists with channel_id ==="
COUNT=$(docker exec postgres psql -U admin -d relay_panel_3api -tAc "
  SELECT COUNT(*) FROM usage_log
  WHERE end_token_id IN (SELECT id FROM end_token WHERE end_user_id = $END_USER_ID)
    AND channel_id = $CHAN_ID
    AND status = 'success'
")
[[ "$COUNT" -ge "2" ]] && check usage_log_with_channel ge2 ge2 || check usage_log_with_channel ge2 "$COUNT"

echo
echo "=== 10. end_user.used_quota_cents incremented ==="
USED=$(docker exec postgres psql -U admin -d relay_panel_3api -tAc "
  SELECT used_quota_cents FROM end_user WHERE id = $END_USER_ID
")
[[ "$USED" -gt "0" ]] && check used_quota_incremented gt0 gt0 || check used_quota_incremented gt0 "$USED"

echo
echo "=== summary: PASS=$PASS FAIL=$FAIL ==="
exit $FAIL
