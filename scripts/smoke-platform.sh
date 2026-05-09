#!/bin/bash
# Smoke-test the /platform tenant-provisioning routes.
set -uo pipefail

PT=$(cat /root/.3api-platform-token)
URL=http://127.0.0.1:3199
SLUG="qa-$(date +%s)"

PASS=0; FAIL=0
check() {
  local label=$1 expected=$2 got=$3
  if [[ "$got" == "$expected" ]]; then
    echo "PASS $label  status=$got"
    PASS=$((PASS+1))
  else
    echo "FAIL $label  expected=$expected got=$got"
    FAIL=$((FAIL+1))
  fi
}

echo "=== platform smoke (token len=${#PT}) ==="

s=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health"); check health 200 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' "$URL/platform/tenants"); check noauth_401 401 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Platform-Token: WRONG" "$URL/platform/tenants"); check wrong_token_401 401 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Platform-Token: $PT" "$URL/platform/tenants"); check list_tenants 200 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"qa@local\",\"admin_password\":\"longpassword12345\"}" \
  "$URL/platform/tenants"); check create_tenant 201 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"admin_email\":\"qa@local\",\"admin_password\":\"longpassword12345\"}" \
  "$URL/platform/tenants"); check duplicate_409 409 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d '{"slug":"www","admin_email":"x@y.local","admin_password":"longpass123"}' \
  "$URL/platform/tenants"); check reserved_400 400 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d '{"slug":"BadSlugCaps","admin_email":"x@y.local","admin_password":"longpass123"}' \
  "$URL/platform/tenants"); check bad_slug_400 400 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d '{"slug":"shortpw-test","admin_email":"x@y.local","admin_password":"abc"}' \
  "$URL/platform/tenants"); check short_pw_400 400 "$s"

s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" -H 'Content-Type: application/json' \
  -d '{"slug":"no-email","admin_password":"longpass123"}' \
  "$URL/platform/tenants"); check missing_email_400 400 "$s"

# verify the new tenant's admin can actually log in via subdomain Host header
s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: ${SLUG}.3api.pro" -H 'Content-Type: application/json' \
  -d '{"email":"qa@local","password":"longpassword12345"}' \
  "$URL/admin/login"); check tenant_admin_login 200 "$s"

# protect tenant 1 from suspend/activate
s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" \
  "$URL/platform/tenants/1/suspend"); check protect_tenant_1 400 "$s"

# suspend the new tenant + verify login then 404s (tenant inactive)
NEW_ID=$(curl -s -H "X-Platform-Token: $PT" "$URL/platform/tenants" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print([t for t in d['data'] if t['slug']=='$SLUG'][0]['id'])")
s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Platform-Token: $PT" \
  "$URL/platform/tenants/$NEW_ID/suspend"); check suspend_new 200 "$s"
s=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Host: ${SLUG}.3api.pro" -H 'Content-Type: application/json' \
  -d '{"email":"qa@local","password":"longpassword12345"}' \
  "$URL/admin/login"); check suspended_blocks_login 404 "$s"

echo "=== summary: PASS=$PASS FAIL=$FAIL ==="
exit $FAIL
