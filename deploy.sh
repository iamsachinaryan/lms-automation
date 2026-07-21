#!/usr/bin/env bash
# =============================================================================
# deploy.sh — One-shot VPS deployment script
# Run as: bash deploy.sh
# Tested on: Ubuntu 22.04 LTS
# =============================================================================

set -euo pipefail

PROJECT_DIR="/opt/lms-automator"
SERVICE_NAME="lms-automator"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  LMS Video Automator — VPS Deployment Script"
echo "══════════════════════════════════════════════════════"
echo ""

# ── 1. Install Docker if not present ─────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[deploy] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "[deploy] Docker installed. You may need to re-login for group membership."
fi

# ── 2. Install Docker Compose plugin if not present ──────────────────────────
if ! docker compose version &>/dev/null 2>&1; then
  echo "[deploy] Installing Docker Compose plugin..."
  sudo apt-get update -qq
  sudo apt-get install -y docker-compose-plugin
fi

# ── 3. Create project directory ───────────────────────────────────────────────
sudo mkdir -p "$PROJECT_DIR"
sudo chown "$USER:$USER" "$PROJECT_DIR"

# ── 4. Copy project files ─────────────────────────────────────────────────────
echo "[deploy] Copying project files to $PROJECT_DIR..."
rsync -av --exclude='node_modules' --exclude='.git' \
  ./ "$PROJECT_DIR/"

cd "$PROJECT_DIR"

# ── 5. Create .env if missing ─────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "[deploy] ⚠️  Created .env from template."
  echo "          Edit it now: nano $PROJECT_DIR/.env"
  echo "          Then re-run this script."
  exit 0
fi

# ── 6. Build Docker image ─────────────────────────────────────────────────────
echo "[deploy] Building Docker image (this takes 2–5 minutes first time)..."
docker compose build --no-cache

# ── 7. Start service ──────────────────────────────────────────────────────────
echo "[deploy] Starting service..."
docker compose up -d

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Deployment complete!"
echo ""
echo "  Health check : curl http://localhost:3001/health"
echo "  Job status   : curl http://localhost:3001/jobs"
echo "  Live logs    : docker compose -f $PROJECT_DIR/docker-compose.yml logs -f"
echo "  Stop         : docker compose -f $PROJECT_DIR/docker-compose.yml down"
echo "══════════════════════════════════════════════════════"
echo ""

# ── 8. Set up logrotate for host-side log management ─────────────────────────
sudo tee /etc/logrotate.d/$SERVICE_NAME > /dev/null << EOF
$PROJECT_DIR/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
EOF

echo "[deploy] Logrotate configured."
