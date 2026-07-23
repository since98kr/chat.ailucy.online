#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Letta full bridge installation failed at line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

[[ "${EUID}" -eq 0 ]] || {
  echo 'Run this installer with sudo: sudo bash ops/letta-bridge/install-hni-node-04.sh'
  exit 1
}

TARGET_USER="${LETTA_BRIDGE_USER:-${SUDO_USER:-}}"
[[ "${TARGET_USER}" =~ ^[a-z_][a-z0-9_-]*$ && "${TARGET_USER}" != 'root' ]] || {
  echo 'Unable to determine a safe non-root Letta user. Set LETTA_BRIDGE_USER explicitly.'
  exit 1
}

TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
[[ -n "${TARGET_HOME}" && -d "${TARGET_HOME}" ]] || {
  echo "Home directory not found for ${TARGET_USER}"
  exit 1
}

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${TARGET_HOME}/.local/share/letta-bridge"
CONFIG_DIR="${TARGET_HOME}/.config"
ENV_FILE="${CONFIG_DIR}/letta-bridge.env"
UNIT_FILE="/etc/systemd/system/letta-bridge.service"
AGENT_ID="${LETTA_AGENT_ID:-agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c}"
LETTA_CWD="${LETTA_CWD:-${TARGET_HOME}/tei-letta}"
LETTA_COMMAND="${LETTA_COMMAND:-${TARGET_HOME}/.local/bin/lucy-routed}"

NODE_BIN="$(
  runuser -u "${TARGET_USER}" -- env HOME="${TARGET_HOME}" bash -lc '
    if command -v node >/dev/null 2>&1; then
      command -v node
      exit 0
    fi
    if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
      # shellcheck disable=SC1091
      . "$HOME/.nvm/nvm.sh"
      command -v node
      exit 0
    fi
    exit 1
  '
)" || {
  echo "Node.js executable was not found for ${TARGET_USER}, including under ${TARGET_HOME}/.nvm."
  exit 1
}
[[ -x "${NODE_BIN}" ]] || { echo "Resolved Node.js path is not executable: ${NODE_BIN}"; exit 1; }
NODE_DIR="$(dirname "${NODE_BIN}")"

CLI_BRIDGE="${SOURCE_DIR}/letta-cli-bridge.mjs"
[[ -f "${CLI_BRIDGE}" ]] || { echo 'letta-cli-bridge.mjs not found'; exit 1; }
[[ -x "${LETTA_COMMAND}" ]] || { echo "Lucy launcher not executable: ${LETTA_COMMAND}"; exit 1; }
[[ -d "${LETTA_CWD}" ]] || { echo "Letta working directory not found: ${LETTA_CWD}"; exit 1; }

printf 'Installing full Letta CLI bridge for %s\n' "${TARGET_USER}"
printf 'Node.js: %s\nLucy launcher: %s\nWorking directory: %s\n' "${NODE_BIN}" "${LETTA_COMMAND}" "${LETTA_CWD}"

install -d -m 0755 -o "${TARGET_USER}" -g "${TARGET_USER}" "${INSTALL_DIR}"
install -m 0755 -o "${TARGET_USER}" -g "${TARGET_USER}" "${CLI_BRIDGE}" "${INSTALL_DIR}/letta-cli-bridge.mjs"
install -d -m 0700 -o "${TARGET_USER}" -g "${TARGET_USER}" "${CONFIG_DIR}"

if [[ ! -f "${ENV_FILE}" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  install -m 0600 -o "${TARGET_USER}" -g "${TARGET_USER}" /dev/null "${ENV_FILE}"
  cat >"${ENV_FILE}" <<ENV
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
LETTA_REQUIRE_RUNTIME_MODEL=true
LETTA_REQUIRE_TOOLS=true
LETTA_REQUIRE_SKILL_SOURCES=true
LETTA_REQUIRE_MCP_SERVERS=true
LETTA_REQUIRE_SLASH_COMMANDS=true
LETTA_REQUIRE_MEMFS=true
LETTA_REQUIRED_TOOLS=
LETTA_REQUIRED_SKILL_SOURCES=
LETTA_REQUIRED_MCP_SERVERS=
LETTA_REQUIRED_SLASH_COMMANDS=
LETTA_EXTRA_ARGS_JSON=[]
ENV
else
  chown "${TARGET_USER}:${TARGET_USER}" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
fi

ensure_env() {
  local name="$1" value="$2"
  if ! grep -q "^${name}=" "${ENV_FILE}"; then
    printf '%s=%s\n' "${name}" "${value}" >>"${ENV_FILE}"
  fi
}

ensure_env LETTA_REQUIRE_RUNTIME_MODEL true
ensure_env LETTA_REQUIRE_TOOLS true
ensure_env LETTA_REQUIRE_SKILL_SOURCES true
ensure_env LETTA_REQUIRE_MCP_SERVERS true
ensure_env LETTA_REQUIRE_SLASH_COMMANDS true
ensure_env LETTA_REQUIRE_MEMFS true
ensure_env LETTA_REQUIRED_TOOLS ''
ensure_env LETTA_REQUIRED_SKILL_SOURCES ''
ensure_env LETTA_REQUIRED_MCP_SERVERS ''
ensure_env LETTA_REQUIRED_SLASH_COMMANDS ''
ensure_env LETTA_EXTRA_ARGS_JSON '[]'

cat >"${UNIT_FILE}" <<UNIT
[Unit]
Description=Lucy Letta Full CLI Runtime Bridge
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
ExecStart=${NODE_BIN} ${INSTALL_DIR}/letta-cli-bridge.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now letta-bridge.service
systemctl restart letta-bridge.service
sleep 3
HEALTH="$(curl -fsS http://127.0.0.1:18283/health)"
printf '%s\n' "${HEALTH}"
node -e 'const j=JSON.parse(process.argv[1]);if(!j.ok||j.mode!=="full-cli-runtime")process.exit(1)' "${HEALTH}"
echo 'Full Letta CLI bridge installed. Bearer token remains only in:'
echo "${ENV_FILE}"
