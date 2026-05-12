#!/usr/bin/env bash
# Smoke for /api/admin/login-lookup happy path:
#   1. signup-tenant on root host
#   2. lookup with that real email → should return the slug
#   3. clean up
set -euo pipefail

B=http://127.0.0.1:3199
PG="psql -q -U admin -d relay_panel_3api -h 127.0.0.1 -p 5432"
export PGPASSWORD=pg_yhn_2026_secure_x7k9m2

EMAIL="lookup-real-$(date +%s%N)@example.com"
PW="smoke-pw-12345"
PASS=0; FAIL=0

# 1. signup
SIGN=$(curl -fsS -m 10 -H 'Host: 3api.pro' -H 'Content-Type: application/json' \
  -X POST -d "{\"admin_email\":\"$EMAIL\",\"admin_password\":\"$PW\"}" \
  "$B/api/signup-tenant")
SLUG=$(echo "$SIGN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("tenant",{}).get("slug",""))')
echo "  slug = $SLUG"

# 2. lookup (give the rate limiter a moment to drain)
sleep 2
LOOK=$(curl -fsS -m 10 -H 'Host: 3api.pro' -H 'content-type: application/json' \
  -X POST -d "{\"email\":\"$EMAIL\"}" \
  "$B/api/admin/login-lookup")
echo "  lookup resp = $LOOK"

if echo "$LOOK" | grep -q "\"tenant_slug\":\"$SLUG\""; then
  echo "  PASS lookup returned matching slug"
  PASS=$((PASS+1))
else
  echo "  FAIL lookup did not return slug"
  FAIL=$((FAIL+1))
fi

# 3. cleanup
$PG -c "DELETE FROM reseller_admin WHERE email='$EMAIL';" >/dev/null 2>&1
TID=$($PG -t -A -c "SELECT id FROM tenant WHERE slug='$SLUG';" | tr -d ' \r\n')
if [ -n "$TID" ]; then
  for t in plans brand_config wholesale_balance; do
    $PG -c "DELETE FROM $t WHERE tenant_id=$TID;" >/dev/null 2>&1
  done
  $PG -c "DELETE FROM tenant WHERE id=$TID;" >/dev/null 2>&1
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
exit $FAIL
