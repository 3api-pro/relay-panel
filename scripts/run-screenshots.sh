#!/usr/bin/env bash
# Seed an idempotent `demo` tenant + admin + end-user, then drive
# Playwright (scripts/screenshot.ts) to capture 5 PNGs into
# docs/assets/. Safe to re-run after each UI change.
#
# Env knobs:
#   PANEL_URL                 default http://localhost:3199
#   ROOT_HOST                 default 3api.pro
#   TENANT_SLUG               default demo
#   TENANT_HOST               default $TENANT_SLUG.$ROOT_HOST
#   PLATFORM_TOKEN            required (read from container env if unset)
#   DEMO_ADMIN_EMAIL          default demo-admin@3api.pro
#   DEMO_ADMIN_PASSWORD       default demo-pass-12345
#   DEMO_ENDUSER_EMAIL        default demo-user@3api.pro
#   DEMO_ENDUSER_PASSWORD     default demo-user-pass-12345
#   POSTGRES_CONTAINER        default postgres (3api-panel runs on host net to localhost:5432)
#   POSTGRES_DB               default relay_panel_3api
#   POSTGRES_USER             default admin
#   HTTPS_PROXY               passed through to playwright if set

set -euo pipefail
cd "$(dirname "$0")/.."

PANEL_URL="${PANEL_URL:-http://localhost:3199}"
ROOT_HOST="${ROOT_HOST:-3api.pro}"
TENANT_SLUG="${TENANT_SLUG:-demo}"
TENANT_HOST="${TENANT_HOST:-${TENANT_SLUG}.${ROOT_HOST}}"
DEMO_ADMIN_EMAIL="${DEMO_ADMIN_EMAIL:-demo-admin@3api.pro}"
DEMO_ADMIN_PASSWORD="${DEMO_ADMIN_PASSWORD:-demo-pass-12345}"
DEMO_ENDUSER_EMAIL="${DEMO_ENDUSER_EMAIL:-demo-user@3api.pro}"
DEMO_ENDUSER_PASSWORD="${DEMO_ENDUSER_PASSWORD:-demo-user-pass-12345}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-relay_panel_3api}"
POSTGRES_USER="${POSTGRES_USER:-admin}"

echo "[1/6] panel health check"
curl -fsS "${PANEL_URL}/health" >/dev/null || { echo "panel not running at ${PANEL_URL}"; exit 1; }

if [[ -z "${PLATFORM_TOKEN:-}" ]]; then
  echo "[1/6] pulling PLATFORM_TOKEN from running 3api-panel container env"
  PLATFORM_TOKEN="$(docker exec 3api-panel printenv PLATFORM_TOKEN 2>/dev/null || true)"
fi
if [[ -z "${PLATFORM_TOKEN:-}" ]]; then
  echo "PLATFORM_TOKEN not provided and could not be read from container"
  exit 1
fi

echo "[2/6] ensure demo tenant + admin (idempotent)"
TENANT_BODY="$(jq -n \
  --arg slug "${TENANT_SLUG}" \
  --arg email "${DEMO_ADMIN_EMAIL}" \
  --arg pw "${DEMO_ADMIN_PASSWORD}" \
  '{slug:$slug,admin_email:$email,admin_password:$pw,branding:{site_name:"Demo Relay"}}')"

CREATE_RESP="$(curl -sS -o /tmp/3api-tenant-create.json -w "%{http_code}" \
  -X POST "${PANEL_URL}/api/platform/tenants" \
  -H "Content-Type: application/json" \
  -H "X-Platform-Token: ${PLATFORM_TOKEN}" \
  -d "${TENANT_BODY}")"
case "${CREATE_RESP}" in
  201) echo "  created tenant ${TENANT_SLUG}";;
  409) echo "  tenant ${TENANT_SLUG} already exists — reusing";;
  *)   echo "  unexpected create_tenant status ${CREATE_RESP}:"; cat /tmp/3api-tenant-create.json; exit 1;;
esac

# Force-resolve admin email + reset password so re-runs across different
# original admin emails always converge to a known credential.
TENANT_ID_PRE="$(docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
  "SELECT id FROM tenant WHERE slug='${TENANT_SLUG}' LIMIT 1;")"
EXISTING_ADMIN_EMAIL="$(docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc \
  "SELECT email FROM reseller_admin WHERE tenant_id=${TENANT_ID_PRE} AND status='active' ORDER BY id ASC LIMIT 1;")"
if [[ -n "${EXISTING_ADMIN_EMAIL}" && "${EXISTING_ADMIN_EMAIL}" != "${DEMO_ADMIN_EMAIL}" ]]; then
  echo "  using existing admin ${EXISTING_ADMIN_EMAIL} (overriding DEMO_ADMIN_EMAIL)"
  DEMO_ADMIN_EMAIL="${EXISTING_ADMIN_EMAIL}"
fi
echo "  resetting password for ${DEMO_ADMIN_EMAIL} (idempotent)"
PASSWORD_HASH="$(node -e "console.log(require('bcryptjs').hashSync('${DEMO_ADMIN_PASSWORD}', 10))")"
docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -q \
  -c "UPDATE reseller_admin SET password_hash='${PASSWORD_HASH}'
        WHERE tenant_id=${TENANT_ID_PRE} AND LOWER(email)=LOWER('${DEMO_ADMIN_EMAIL}');" \
  >/dev/null

echo "[3/6] admin login → cookie + JWT"
LOGIN_RESP="$(mktemp)"
LOGIN_HEADERS="$(mktemp)"
LOGIN_STATUS="$(curl -sS -o "${LOGIN_RESP}" -D "${LOGIN_HEADERS}" -w "%{http_code}" \
  -X POST "${PANEL_URL}/api/admin/login" \
  -H "Host: ${TENANT_HOST}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg e "${DEMO_ADMIN_EMAIL}" --arg p "${DEMO_ADMIN_PASSWORD}" '{email:$e,password:$p}')")"
if [[ "${LOGIN_STATUS}" != "200" ]]; then
  echo "  admin login failed ${LOGIN_STATUS}:"; cat "${LOGIN_RESP}"; exit 1
fi
DEMO_ADMIN_JWT="$(jq -r '.token' < "${LOGIN_RESP}")"
TENANT_ID="$(jq -r '.tenant.id' < "${LOGIN_RESP}")"
if [[ -z "${DEMO_ADMIN_JWT}" || "${DEMO_ADMIN_JWT}" == "null" ]]; then
  echo "  could not extract admin JWT"; cat "${LOGIN_RESP}"; exit 1
fi
echo "  admin JWT ok (tenant_id=${TENANT_ID})"

echo "[4/6] topup wholesale_balance + ensure demo storefront has activity"
docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO wholesale_balance (tenant_id, balance_cents)
        VALUES (${TENANT_ID}, 50000)
        ON CONFLICT (tenant_id) DO UPDATE
          SET balance_cents = GREATEST(EXCLUDED.balance_cents, wholesale_balance.balance_cents);" \
  >/dev/null

echo "[5/6] end-user signup (idempotent) + topup quota"
SIGNUP_STATUS="$(curl -sS -o /tmp/3api-signup.json -w "%{http_code}" \
  -X POST "${PANEL_URL}/api/customer/signup" \
  -H "Content-Type: application/json" \
  -H "Host: ${TENANT_HOST}" \
  -d "$(jq -n --arg e "${DEMO_ENDUSER_EMAIL}" --arg p "${DEMO_ENDUSER_PASSWORD}" \
    '{email:$e,password:$p,display_name:"Demo User"}')")"
DEMO_ENDUSER_JWT=""
if [[ "${SIGNUP_STATUS}" == "201" ]]; then
  DEMO_ENDUSER_JWT="$(jq -r '.token' < /tmp/3api-signup.json)"
  echo "  end-user created"
else
  # already exists — login
  LOGIN_USER_STATUS="$(curl -sS -o /tmp/3api-userlogin.json -w "%{http_code}" \
    -X POST "${PANEL_URL}/api/customer/login" \
    -H "Content-Type: application/json" \
    -H "Host: ${TENANT_HOST}" \
    -d "$(jq -n --arg e "${DEMO_ENDUSER_EMAIL}" --arg p "${DEMO_ENDUSER_PASSWORD}" \
      '{email:$e,password:$p}')")"
  if [[ "${LOGIN_USER_STATUS}" != "200" ]]; then
    echo "  end-user login failed ${LOGIN_USER_STATUS}:"; cat /tmp/3api-userlogin.json; exit 1
  fi
  DEMO_ENDUSER_JWT="$(jq -r '.token' < /tmp/3api-userlogin.json)"
  echo "  end-user reused"
fi
# give the user a visible balance so the dashboard widget renders nicely.
docker exec "${POSTGRES_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -q \
  -c "UPDATE end_user
        SET quota_cents      = 20000,
            used_quota_cents = 350
      WHERE tenant_id=${TENANT_ID} AND email='${DEMO_ENDUSER_EMAIL}';" \
  >/dev/null

echo "[6/6] launching playwright"
export DEMO_ADMIN_JWT DEMO_ENDUSER_JWT
export SCREENSHOT_BASE_URL="${PANEL_URL}"
export SCREENSHOT_ROOT_HOST="${ROOT_HOST}"
export SCREENSHOT_TENANT_HOST="${TENANT_HOST}"
export SCREENSHOT_OUT_DIR="$(pwd)/docs/assets"

# Playwright launches a local chromium binary — no proxy needed at runtime.
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy 2>/dev/null || true

npx tsx scripts/screenshot.ts

echo
echo "[done] new PNGs:"
ls -la docs/assets/screenshot-*.png
