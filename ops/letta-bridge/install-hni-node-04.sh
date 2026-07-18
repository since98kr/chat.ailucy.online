#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${TARGET_HOME}/.local/share/letta-bridge"
CONFIG_DIR="${TARGET_HOME}/.config"
ENV_FILE="${CONFIG_DIR}/letta-bridge.env"
UNIT_FILE="/etc/systemd/system/letta-bridge.service"
AGENT_ID="agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c"
LETTA_CWD="${TARGET_HOME}/tei-letta"
LETTA_COMMAND="${TARGET_HOME}/.local/bin/lucy-routed"
NODE_BIN="$(sudo -u "${TARGET_USER}" bash -lc 'command -v node')"
NODE_DIR="$(dirname "${NODE_BIN}")"

[[ -f "${SOURCE_DIR}/letta-bridge.mjs" ]] || { echo 'letta-bridge.mjs not found'; exit 1; }
[[ -x "${LETTA_COMMAND}" ]] || { echo "Lucy launcher not executable: ${LETTA_COMMAND}"; exit 1; }
[[ -d "${LETTA_CWD}" ]] || { echo "Letta working directory not found: ${LETTA_CWD}"; exit 1; }

sudo install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_USER}" "${INSTALL_DIR}"
sudo install -m 0755 -o "${TARGET_USER}" -g "${TARGET_USER}" \
  "${SOURCE_DIR}/letta-bridge.mjs" "${INSTALL_DIR}/letta-bridge.mjs"
sudo install -d -m 0700 -o "${TARGET_USER}" -g "${TARGET_USER}" "${CONFIG_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  sudo -u "${TARGET_USER}" tee "${ENV_FILE}" >/dev/null <<ENV
LETTA_BRIDGE_HOST=127.0.0.1
LETTA_BRIDGE_PORT=18283
LETTA_BRIDGE_TOKEN=${TOKEN}
LETTA_AGENT_ID=${AGENT_ID}
LETTA_COMMAND=${LETTA_COMMAND}
LETTA_CWD=${LETTA_CWD}
LETTA_BACKEND=local
LETTA_MAX_SESSIONS=8
LETTA_SESSION_IDLE_MS=1800000
LETTA_REQUEST_TIMEOUT_MS=300000
LETTA_LOCAL_BACKEND_DIR=${LETTA_CWD}/.letta-local
ENV
  chmod 0600 "${ENV_FILE}"
fi

sudo tee "${UNIT_FILE}" >/dev/null <<UNIT
[Unit]
Description=Lucy Letta Thin Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
WorkingDirectory=${LETTA_CWD}
Environment=HOME=${TARGET_HOME}
Environment=PATH=${TARGET_HOME}/.local/bin:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/letta-bridge.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now letta-bridge.service
sleep 2
curl -fsS http://127.0.0.1:18283/health
echo
echo 'Letta bridge installed. Bearer token remains in:'
echo "${ENV_FILE}"
