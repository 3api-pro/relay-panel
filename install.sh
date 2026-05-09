#!/bin/bash
# 3API Relay Panel — one-click installer
#
# Usage (interactive — recommended):
#   curl -fsSL https://3api.pro/install -o install.sh && bash install.sh
#
# Usage (pure pipe + env vars — non-interactive):
#   curl -fsSL https://3api.pro/install | DOMAIN=relay.example.com UPSTREAM_KEY=wsk-... bash
#
# Usage (force build from source instead of registry — current default):
#   IMAGE_SOURCE=build curl ... | bash
set -euo pipefail

DOMAIN="${DOMAIN:-}"
UPSTREAM_KEY="${UPSTREAM_KEY:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/3api-panel}"
REPO_URL="${REPO_URL:-https://github.com/3api-pro/relay-panel.git}"
IMAGE_SOURCE="${IMAGE_SOURCE:-build}"   # build | registry

require_root() {
  if [[ "$EUID" -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo "ERROR: must run as root (or have sudo installed)" >&2
    exit 1
  fi
}

# ask "prompt" VAR  — reads from /dev/tty so it works under curl|bash too
ask() {
  local prompt="$1" __var="$2" reply
  if [[ -t 0 ]]; then
    read -r -p "$prompt" reply
  elif [[ -e /dev/tty ]]; then
    read -r -p "$prompt" reply </dev/tty
  else
    echo "ERROR: no terminal available — set ${__var} via env var instead" >&2
    exit 1
  fi
  printf -v "$__var" '%s' "$reply"
}

echo "==================================="
echo "  3API Relay Panel — Quick Setup"
echo "==================================="

require_root

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "[1/6] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[2/6] Installing Docker Compose plugin..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y docker-compose-plugin
  elif command -v yum >/dev/null 2>&1; then
    yum install -y docker-compose-plugin
  else
    echo "ERROR: no apt-get or yum — install docker-compose-plugin manually" >&2
    exit 1
  fi
fi

# 2. Source — clone the repo so we can build locally + edit configs
echo "[3/6] Fetching source into $INSTALL_DIR..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$INSTALL_DIR"
  if [[ -n "$(ls -A "$INSTALL_DIR")" ]]; then
    echo "ERROR: $INSTALL_DIR exists and is not a git repo. Set INSTALL_DIR=/another/path." >&2
    exit 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    apt-get install -y git || yum install -y git
  fi
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 3. Inputs
[[ -n "$DOMAIN" ]] || ask "Your domain (e.g., relay.example.com): " DOMAIN
[[ -n "$DOMAIN" ]] || { echo "ERROR: DOMAIN is required" >&2; exit 1; }

[[ -n "$UPSTREAM_KEY" ]] || ask "Your 3API wholesale key (wsk-...): " UPSTREAM_KEY
[[ -n "$UPSTREAM_KEY" ]] || { echo "ERROR: UPSTREAM_KEY is required" >&2; exit 1; }

# 4. Configs — generate fresh .env + patch Caddyfile
echo "[4/6] Generating .env + Caddyfile..."
JWT_SECRET=$(openssl rand -base64 32 | tr -d '\n')
ADMIN_PW=$(openssl rand -hex 8)
PG_PASSWORD=$(openssl rand -hex 16)

cat > .env <<EOF
NODE_ENV=production
PORT=8080
PUBLIC_URL=https://${DOMAIN}

DATABASE_URL=postgresql://3api:${PG_PASSWORD}@postgres:5432/relay_panel
POSTGRES_PASSWORD=${PG_PASSWORD}

TENANT_MODE=single

UPSTREAM_BASE_URL=https://api.llmapi.pro/wholesale/v1
UPSTREAM_KEY=${UPSTREAM_KEY}

JWT_SECRET=${JWT_SECRET}
ADMIN_DEFAULT_PASSWORD=${ADMIN_PW}

LOG_LEVEL=info
AUTO_UPDATE=on
EOF
chmod 600 .env

# Patch Caddyfile placeholder
sed -i "s|^YOUR_DOMAIN |${DOMAIN} |" Caddyfile

# 5. Build (or pull)
if [[ "$IMAGE_SOURCE" == "registry" ]]; then
  echo "[5/6] Pulling image..."
  docker compose pull
else
  echo "[5/6] Building image from source..."
  docker compose build
fi

echo "[6/6] Starting services..."
docker compose up -d

cat <<EOF

================================================
  ✓ 3API Panel is starting
================================================
  URL:                  https://${DOMAIN}
  Admin password:       ${ADMIN_PW}
  Wholesale key:        ${UPSTREAM_KEY:0:14}...
  Postgres password:    (in $INSTALL_DIR/.env)

  First-run: visit https://${DOMAIN}/admin/login
  Username:  admin@panel.local  (override via ADMIN_DEFAULT_EMAIL)
  Logs:      cd $INSTALL_DIR && docker compose logs -f panel

  Save this output — the password is only shown once.
================================================
EOF
