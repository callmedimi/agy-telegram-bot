#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME="agy-telegram-bot.service"
SERVICE_DEST="/etc/systemd/system/${SERVICE_NAME}"

# Ensure ~/.local/bin is in PATH for agy detection
if [ -d "${HOME}/.local/bin" ] && [[ ":${PATH}:" != *":${HOME}/.local/bin:"* ]]; then
  export PATH="${HOME}/.local/bin:${PATH}"
fi

echo "=============================================="
echo "  Antigravity Telegram Bot — Installer"
echo "=============================================="
echo "Repository : ${REPO_DIR}"
echo ""

# 1. Check Node.js >= 22
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed. Please install Node.js >= 22 and retry."
  exit 1
fi

NODE_VERSION_RAW="$(node -v)"
NODE_MAJOR="$(echo "${NODE_VERSION_RAW#v}" | cut -d. -f1)"
if ! [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "❌ Node.js >= 22 is required (found ${NODE_VERSION_RAW})."
  exit 1
fi
echo "✅ Node.js ${NODE_VERSION_RAW}"

# 2. Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm is not installed."
  exit 1
fi

# 3. Check agy CLI
AGY_PATH=""
if command -v agy >/dev/null 2>&1; then
  AGY_PATH="$(command -v agy)"
elif [ -x "${HOME}/.local/bin/agy" ]; then
  AGY_PATH="${HOME}/.local/bin/agy"
fi

if [ -n "${AGY_PATH}" ]; then
  AGY_VER="$("${AGY_PATH}" --version 2>/dev/null || echo 'unknown')"
  echo "✅ agy CLI found at ${AGY_PATH} (${AGY_VER})"
else
  echo "⚠️  agy CLI not found in PATH or ${HOME}/.local/bin/agy."
  echo "   Install Antigravity CLI before running the bot."
fi

echo ""
cd "${REPO_DIR}"

# 4. Install dependencies and build
echo "📦 Installing npm dependencies..."
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

echo "🔨 Building TypeScript..."
npm run build

# 5. Run interactive setup if .env is missing
if [ ! -f "${REPO_DIR}/.env" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo ""
    echo "⚙️  No .env file found. Launching setup wizard..."
    node "${REPO_DIR}/scripts/setup.mjs"
  else
    echo ""
    echo "ℹ️  Non-interactive shell detected and .env does not exist."
    echo "   Run the setup wizard manually:"
    echo "     cd \"${REPO_DIR}\" && node scripts/setup.mjs"
    echo "   Or copy .env.example to .env and fill in BOT_TOKEN and ALLOWED_USER_IDS."
  fi
else
  echo "✅ Existing .env preserved at ${REPO_DIR}/.env"
fi

# 6. Offer systemd service installation
if [ -t 0 ] && [ -t 1 ] && command -v systemctl >/dev/null 2>&1; then
  echo ""
  read -r -p "Install and enable systemd service (${SERVICE_DEST})? [y/N]: " INSTALL_SYS
  if [[ "${INSTALL_SYS}" =~ ^[Yy]$ ]]; then
    CURRENT_USER="$(id -un)"
    CURRENT_HOME="${HOME}"
    NODE_BIN_DIR="$(dirname "$(command -v node)")"
    EFFECTIVE_PATH="${NODE_BIN_DIR}:${CURRENT_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"

    TMP_UNIT="$(mktemp)"
    cat > "${TMP_UNIT}" <<EOF
[Unit]
Description=Antigravity Telegram Bot (agy-telegram-bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${REPO_DIR}
Environment=HOME=${CURRENT_HOME}
Environment=NODE_ENV=production
Environment=PATH=${EFFECTIVE_PATH}
EnvironmentFile=-${REPO_DIR}/.env
ExecStart=/usr/bin/env node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agy-telegram-bot

[Install]
WantedBy=multi-user.target
EOF

    if [ "$(id -u)" -eq 0 ]; then
      mv "${TMP_UNIT}" "${SERVICE_DEST}"
      chmod 644 "${SERVICE_DEST}"
      systemctl daemon-reload
      systemctl enable --now "${SERVICE_NAME}"
      systemctl status "${SERVICE_NAME}" --no-pager || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo mv "${TMP_UNIT}" "${SERVICE_DEST}"
      sudo chmod 644 "${SERVICE_DEST}"
      sudo systemctl daemon-reload
      sudo systemctl enable --now "${SERVICE_NAME}"
      sudo systemctl status "${SERVICE_NAME}" --no-pager || true
    else
      rm -f "${TMP_UNIT}"
      echo "⚠️  Root privileges or sudo required to install ${SERVICE_DEST}."
    fi
  fi
fi

echo ""
echo "✅ Installation complete!"
if [ -f "${REPO_DIR}/.env" ]; then
  echo "   Run manually with: cd \"${REPO_DIR}\" && npm start"
else
  echo "   Next: cd \"${REPO_DIR}\" && npm run setup && npm start"
fi
