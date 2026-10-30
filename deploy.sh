#!/usr/bin/env bash
# deploy.sh — one-command deploy to a DigitalOcean Droplet (or any Ubuntu VPS)
# Usage: ./deploy.sh [host] [user]
#   host  — your server IP or domain (default: $DEPLOY_HOST env var)
#   user  — SSH user (default: root)
#
# Prerequisites on the server (run once):
#   apt-get update && apt-get install -y docker.io docker-compose-v2
#   systemctl enable --now docker
#
# On your machine: set DEPLOY_HOST in .env.local or pass as arg.

set -euo pipefail

HOST="${1:-${DEPLOY_HOST:?Set DEPLOY_HOST or pass host as first arg}}"
SSH_USER="${2:-root}"
REMOTE="$SSH_USER@$HOST"
APP_DIR="/opt/rejekt-ai"

echo "▶ Deploying to $REMOTE:$APP_DIR"

# 1. Sync source (exclude node_modules and local env)
echo "  → Syncing files..."
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='uploads' \
  --exclude='playwright-browsers' \
  ./ "$REMOTE:$APP_DIR/"

# 2. Copy env file (never committed to git)
echo "  → Uploading .env.local..."
scp .env.local "$REMOTE:$APP_DIR/.env.local"

# 3. Build + restart on server
echo "  → Building and restarting containers..."
ssh "$REMOTE" bash << REMOTE_SCRIPT
  set -euo pipefail
  cd $APP_DIR

  # Pull latest base images
  docker compose pull db 2>/dev/null || true

  # Build app image
  docker compose build --no-cache app

  # Run DB migrations if migrate script exists
  if [ -f migrate.mjs ]; then
    docker compose run --rm app node migrate.mjs
  fi

  # Rolling restart: stop old, start new
  docker compose up -d --remove-orphans
  docker compose ps
REMOTE_SCRIPT

echo ""
echo "✅ Deploy complete — app running at http://$HOST:3000"
echo "   Logs: ssh $REMOTE 'docker compose -C $APP_DIR logs -f app'"
