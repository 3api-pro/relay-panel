#!/bin/bash
# 3API Relay Panel — one-click installer
# Usage: curl -sSL https://3api.pro/install | bash
set -euo pipefail

DOMAIN="${DOMAIN:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/3api-panel}"

echo "==================================="
echo "  3API Relay Panel — Quick Setup"
echo "==================================="
echo ""

# 1. Detect OS, install Docker if missing
if ! command -v docker >/dev/null 2>&1; then
    echo "[1/5] Installing Docker..."
    curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "[2/5] Installing Docker Compose plugin..."
    apt-get update -qq && apt-get install -y docker-compose-plugin || \
      yum install -y docker-compose-plugin || true
fi

# 2. Prepare install dir
echo "[3/5] Preparing $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 3. Pull docker-compose.yml
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/docker-compose.yml -o docker-compose.yml
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/Caddyfile -o Caddyfile
curl -sSL https://raw.githubusercontent.com/3api-pro/relay-panel/main/.env.example -o .env.example
[ -f .env ] || cp .env.example .env

# 4. Prompt for domain + wholesale key (interactive)
if [ -z "$DOMAIN" ]; then
    read -p "Your domain (e.g., relay.example.com): " DOMAIN
fi
read -p "Your 3API wholesale key (wsk-...): " UPSTREAM_KEY

# 5. Patch config
sed -i "s|YOUR_DOMAIN|${DOMAIN}|" Caddyfile
sed -i "s|^UPSTREAM_KEY=.*|UPSTREAM_KEY=${UPSTREAM_KEY}|" .env
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${DOMAIN}|" .env

# Generate random JWT secret + admin password
JWT_SECRET=$(openssl rand -base64 32 | tr -d '\n')
ADMIN_PW=$(openssl rand -hex 8)
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
sed -i "s|^ADMIN_DEFAULT_PASSWORD=.*|ADMIN_DEFAULT_PASSWORD=${ADMIN_PW}|" .env

echo "[4/5] Pulling Docker images..."
docker compose pull

echo "[5/5] Starting services..."
docker compose up -d

echo ""
echo "================================================"
echo "  ✓ 3API Panel is starting"
echo "================================================"
echo "  URL:           https://${DOMAIN}"
echo "  Admin:         admin / ${ADMIN_PW}"
echo "  Wholesale key: ${UPSTREAM_KEY:0:14}..."
echo ""
echo "  First-run: visit /admin to complete setup."
echo "  Logs:      docker compose logs -f panel"
echo "================================================"
