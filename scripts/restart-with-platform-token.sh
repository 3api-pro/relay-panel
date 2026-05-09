#!/bin/bash
# Regenerate PLATFORM_TOKEN, persist, restart container with full env.
set -euo pipefail

PT="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
echo "${PT}" > /root/.3api-platform-token
chmod 600 /root/.3api-platform-token
echo "PT_LEN=${#PT}"

docker rm -f 3api-panel 2>/dev/null || true
docker run -d --name 3api-panel \
  --restart unless-stopped --network host \
  -e DATABASE_URL='postgresql://admin:pg_yhn_2026_secure_x7k9m2@127.0.0.1:5432/relay_panel_3api' \
  -e PORT=3199 -e TENANT_MODE=multi -e SAAS_DOMAIN=3api.pro \
  -e PUBLIC_URL=https://3api.pro \
  -e UPSTREAM_KEY='wsk-fake-pending-real-deploy' \
  -e UPSTREAM_BASE_URL='https://api.llmapi.pro/wholesale/v1' \
  -e JWT_SECRET='prod3api-secret-32chars-aaaaaaaaaaaaaa' \
  -e ADMIN_DEFAULT_EMAIL='admin@3api.pro' \
  -e ADMIN_DEFAULT_PASSWORD='admin-3api-init-pwd-CHANGEME' \
  -e PLATFORM_TOKEN="${PT}" \
  3api-panel:local

sleep 3
echo "--- container ---"
docker ps --filter name=3api-panel --format '{{.Names}} {{.Status}}'
echo "--- logs ---"
docker logs 3api-panel 2>&1 | tail -10
