#!/bin/bash
# Smoke test — admin flow + /v1 auth surface.
# Single-tenant: just run.
# Multi-tenant: HOST_HEADER=default.3api.pro bash smoke-test.sh
set +e
B=${BASE_URL:-http://127.0.0.1:3199}

echo "=== 1. /admin/login ==="
LOGIN_RES=$(curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/admin/login -H 'Content-Type: application/json' -d '{"email":"smoke@panel.local","password":"admin123"}')
echo "$LOGIN_RES" | python3 -m json.tool
TOKEN=$(echo "$LOGIN_RES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
echo "token: ${TOKEN:0:30}..."

echo ""
echo "=== 2. POST /admin/end-users ==="
USER_RES=$(curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/admin/end-users -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"email":"customer1@example.com","password":"cust123","display_name":"Customer One","initial_quota_cents":500}')
echo "$USER_RES" | python3 -m json.tool
USER_ID=$(echo "$USER_RES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

echo ""
echo "=== 3. topup +¥10 (1000c) for user $USER_ID ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/admin/end-users/$USER_ID/topup -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"amount_cents":1000}' | python3 -m json.tool

echo ""
echo "=== 4. issue sk- token for user $USER_ID ==="
TOK_RES=$(curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/admin/end-users/$USER_ID/tokens -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"smoke-token","unlimited_quota":true}')
echo "$TOK_RES" | python3 -m json.tool
SK=$(echo "$TOK_RES" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
echo "sk-: ${SK:0:32}..."

echo ""
echo "=== 5. /admin/usage/summary ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} $B/admin/usage/summary -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

echo ""
echo "=== 6. /v1/models with sk-: expect 200 ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} $B/v1/models -H "Authorization: Bearer $SK" | python3 -m json.tool

echo ""
echo "=== 7. /v1/models WITHOUT key: expect 401 ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -w '\nHTTP:%{http_code}\n' $B/v1/models | head -5

echo ""
echo "=== 8. /v1/models with WRONG sk-: expect 401 ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -w '\nHTTP:%{http_code}\n' $B/v1/models -H 'Authorization: Bearer sk-relay-fake-1234567890abcdef' | head -5

echo ""
echo "=== 9. /v1/messages with valid sk- (upstream is fake = 502 expected) ==="
curl -sS -m 10 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -w '\nHTTP:%{http_code}\n' -X POST $B/v1/messages -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' -d '{"model":"claude-sonnet-4-7","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}' | head -5

echo ""
echo "=== 10. /customer/signup as new customer ==="
SIGNUP=$(curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/customer/signup -H 'Content-Type: application/json' -d '{"email":"selfsignup@example.com","password":"pass123","display_name":"Self Signup"}')
echo "$SIGNUP" | python3 -m json.tool
CUST_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')

echo ""
echo "=== 11. /customer/me with self-signup token ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} $B/customer/me -H "Authorization: Bearer $CUST_TOK" | python3 -m json.tool

echo ""
echo "=== 12. /customer/tokens POST issue own key ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/customer/tokens -H "Authorization: Bearer $CUST_TOK" -H 'Content-Type: application/json' -d '{"name":"my-key","unlimited_quota":false,"remain_quota_cents":0}' | python3 -m json.tool

echo ""
echo "=== 13. /admin/redemption batch generate 3 codes ==="
curl -sS -m 5 ${HOST_HEADER:+-H "Host: $HOST_HEADER"} -X POST $B/admin/redemption -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"quota_cents":500,"count":3,"prefix":"SMK"}' | python3 -m json.tool
