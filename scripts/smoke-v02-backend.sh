#!/bin/bash
# Smoke test — v0.2 backend (channel multi-key + daily check-in + system
# settings).  Runs after the panel container has been rebuilt with all
# three migrations applied + the new routes wired.
#
# Requires:
#   - 3api-panel listening on :3199 (TENANT_MODE=multi, SAAS_DOMAIN=3api.pro)
#   - postgres on :5432 (db=relay_panel_3api, user=admin)
#   - tenant id=1 (slug=default), seeded admin admin@3api.pro
#   - mock upstream on :19999 (script starts it if absent)
#
# Exits non-zero if any check fails. Verbose pass/fail per step.
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
# Setup: mock upstream + a tenant-1 default channel + admin login.
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
$PG -c "DELETE FROM upstream_channel WHERE tenant_id=1 AND name='v02-smoke-mock';" >/dev/null
$PG -c "INSERT INTO upstream_channel (tenant_id, name, base_url, api_key, type, status, weight, priority, is_default, group_access, keys) VALUES (1, 'v02-smoke-mock', 'http://127.0.0.1:19999/v1', 'test-byok-key-1234', 'byok-claude', 'active', 100, 1, FALSE, 'default', '[{\"key\":\"test-byok-key-1234\",\"status\":\"active\",\"added_at\":\"2026-01-01T00:00:00Z\",\"cooled_until\":null,\"last_error\":null}]'::jsonb);" >/dev/null
ADMIN=$(ch -X POST $B/admin/login -H 'Content-Type: application/json' -d '{"email":"admin@3api.pro","password":"admin-3api-init-pwd-CHANGEME"}')
ADMIN_TOK=$(echo "$ADMIN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -z "$ADMIN_TOK" ]; then bad "admin login failed: $ADMIN"; exit 1; fi
ok "setup complete (admin token, mock upstream, channel)"
AUTH="Authorization: Bearer $ADMIN_TOK"

# ------------------------------------------------------------------------
# Section A — Channel multi-key (P1 #14): 4 checks
# ------------------------------------------------------------------------

# Find the smoke channel id
CHID=$($PG -t -A -c "SELECT id FROM upstream_channel WHERE tenant_id=1 AND name='v02-smoke-mock' LIMIT 1;" | tr -d ' ')

note "A1. GET /admin/channels returns keys[] masked"
# /admin/channels is intercepted by Next static UI redirect-to-trailing-slash
# at the API prefix. Use /api/admin/* for raw JSON.
LST=$(ch -H "$AUTH" "$B/api/admin/channels")
HAS_KEYS=$(echo "$LST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for row in d.get('data', []):
  if row.get('name')=='v02-smoke-mock':
    keys=row.get('keys',[])
    if isinstance(keys, list) and len(keys)>=1 and 'preview' in keys[0] and 'status' in keys[0] and 'test-byok-key' not in keys[0].get('preview',''):
      print('y'); break
" 2>/dev/null)
if [ "$HAS_KEYS" = "y" ]; then ok "channel keys[] masked + status present"; else bad "keys[] missing or unmasked: $LST"; fi

note "A2. POST /admin/channels/:id/keys appends a key"
ADD=$(chw -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"key":"new-second-key-abcdef"}' "$B/admin/channels/$CHID/keys")
ADD_CODE=$(http_of "$ADD")
KEYS_TOTAL=$(body_of "$ADD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("keys_total",0))' 2>/dev/null)
if [ "$ADD_CODE" = "201" ] && [ "$KEYS_TOTAL" = "2" ]; then ok "added (keys_total=2)"; else bad "add key failed: code=$ADD_CODE body=$(body_of "$ADD")"; fi

note "A3. DELETE /admin/channels/:id/keys/:idx removes it"
RM=$(chw -X DELETE -H "$AUTH" "$B/admin/channels/$CHID/keys/1")
RM_CODE=$(http_of "$RM")
RM_TOTAL=$(body_of "$RM" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("keys_total",-1))' 2>/dev/null)
if [ "$RM_CODE" = "200" ] && [ "$RM_TOTAL" = "1" ]; then ok "removed (keys_total=1)"; else bad "remove failed: code=$RM_CODE body=$(body_of "$RM")"; fi

note "A4. PATCH /admin/channels/:id with keys[] bulk replace"
PAT=$(ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"keys":["bulk-key-one-abc","bulk-key-two-def","bulk-key-three-ghi"]}' \
  "$B/admin/channels/$CHID")
PT=$(echo "$PAT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("keys_total",0))' 2>/dev/null)
PA=$(echo "$PAT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("keys_active",0))' 2>/dev/null)
if [ "$PT" = "3" ] && [ "$PA" = "3" ]; then ok "bulk replace 3/3 active"; else bad "bulk replace failed: $PAT"; fi

# Restore the smoke key for relay tests.
$PG -c "UPDATE upstream_channel SET keys = '[{\"key\":\"test-byok-key-1234\",\"status\":\"active\",\"added_at\":\"2026-01-01T00:00:00Z\",\"cooled_until\":null,\"last_error\":null}]'::jsonb, current_key_idx=0 WHERE id=$CHID;" >/dev/null

# ------------------------------------------------------------------------
# Section B — Daily check-in (P1 #15): 4 checks
# ------------------------------------------------------------------------

note "B0. sign up an end-user + give them an active subscription"
EMAIL="checkin-smoke-$(date +%s%N)@example.com"
SIGNUP=$(ch -X POST $B/storefront/auth/signup -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"smoke12345\"}")
USER_TOK=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
USER_ID=$(echo "$SIGNUP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user",{}).get("id",""))' 2>/dev/null)
if [ -z "$USER_TOK" ]; then bad "signup failed: $SIGNUP"; exit 1; fi
# Plug in a synthetic active subscription so check-in has somewhere to credit.
$PG -c "DELETE FROM subscription WHERE end_user_id=$USER_ID;" >/dev/null
$PG -c "INSERT INTO subscription (tenant_id, end_user_id, plan_name, status, period_start, period_end, expires_at, remaining_tokens, is_primary) VALUES (1, $USER_ID, 'smoke-plan', 'active', NOW(), NOW()+INTERVAL '30 days', NOW()+INTERVAL '30 days', 1000000, TRUE);" >/dev/null
ok "user $USER_ID + synth sub created"
UAUTH="Authorization: Bearer $USER_TOK"

note "B1. GET /storefront/checkin/status (not checked in)"
ST=$(ch -H "$UAUTH" $B/storefront/checkin/status)
ALREADY=$(echo "$ST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("already_checked_in"))' 2>/dev/null)
NEXT=$(echo "$ST" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("next_reward_tokens",0))' 2>/dev/null)
if [ "$ALREADY" = "False" ] && [ "$NEXT" -gt 0 ] 2>/dev/null; then ok "status shows not-yet-checked, next_reward=$NEXT"; else bad "status malformed: $ST"; fi

note "B2. POST /storefront/checkin grants reward"
CK=$(ch -X POST -H "$UAUTH" $B/storefront/checkin)
OK_=$(echo "$CK" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))' 2>/dev/null)
RT=$(echo "$CK" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reward_tokens",0))' 2>/dev/null)
SD=$(echo "$CK" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("streak_days",0))' 2>/dev/null)
if [ "$OK_" = "True" ] && [ "$RT" -gt 0 ] 2>/dev/null && [ "$SD" -ge 1 ] 2>/dev/null; then
  ok "check-in granted reward=$RT streak=$SD"
else
  bad "check-in failed: $CK"
fi

note "B3. POST again same day → 409 already_checked_in"
CK2=$(chw -X POST -H "$UAUTH" $B/storefront/checkin)
CK2_CODE=$(http_of "$CK2")
if [ "$CK2_CODE" = "409" ]; then ok "second check-in correctly 409"; else bad "expected 409, got $CK2_CODE: $(body_of "$CK2")"; fi

note "B4. GET /storefront/checkin/history shows the row"
HIS=$(ch -H "$UAUTH" $B/storefront/checkin/history)
N=$(echo "$HIS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)
if [ "$N" -ge 1 ] 2>/dev/null; then ok "history has $N row(s)"; else bad "history empty: $HIS"; fi

# ------------------------------------------------------------------------
# Section C — System settings (P1 #10): 4 checks
# ------------------------------------------------------------------------

note "C1. GET /admin/system-setting returns defaults"
SS=$(ch -H "$AUTH" $B/admin/system-setting)
SE=$(echo "$SS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("signup_enabled"))' 2>/dev/null)
MM=$(echo "$SS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("maintenance_mode"))' 2>/dev/null)
if [ "$SE" = "True" ] && [ "$MM" = "False" ]; then ok "defaults signup=on maintenance=off"; else bad "defaults wrong: $SS"; fi

note "C2. PATCH announcement + level"
PAT2=$(ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"announcement":"v0.2 smoke test","announcement_level":"warn"}' \
  $B/admin/system-setting)
ANN=$(echo "$PAT2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("announcement",""))' 2>/dev/null)
LVL=$(echo "$PAT2" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("announcement_level",""))' 2>/dev/null)
if [ "$ANN" = "v0.2 smoke test" ] && [ "$LVL" = "warn" ]; then ok "PATCH persisted announcement+level"; else bad "patch failed: $PAT2"; fi

note "C3. /storefront/brand surfaces system_announcement"
BR=$(ch $B/storefront/brand)
SA=$(echo "$BR" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("system_announcement",""))' 2>/dev/null)
SAL=$(echo "$BR" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("system_announcement_level",""))' 2>/dev/null)
if [ "$SA" = "v0.2 smoke test" ] && [ "$SAL" = "warn" ]; then ok "storefront/brand merged system fields"; else bad "brand missing system fields: $BR"; fi

note "C4. flip maintenance_mode → /storefront/plans returns 503, then restore"
ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' -d '{"maintenance_mode":true}' $B/admin/system-setting >/dev/null
# Cache TTL is 30s — wait 31s OR call invalidateCache via a direct DB
# trick. Faster path: hit /admin/system-setting which calls patchForTenant
# (already done above), invalidating the cache for tenant 1.
M=$(chw $B/storefront/plans)
MCODE=$(http_of "$M")
ch -X PATCH -H "$AUTH" -H 'Content-Type: application/json' -d '{"maintenance_mode":false,"announcement":null}' $B/admin/system-setting >/dev/null
if [ "$MCODE" = "503" ]; then ok "maintenance gate 503'd /storefront/plans"; else bad "expected 503, got $MCODE"; fi

# ------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  v0.2 backend smoke: PASS=$PASS FAIL=$FAIL"
echo "==========================================="
[ "$FAIL" = "0" ]
