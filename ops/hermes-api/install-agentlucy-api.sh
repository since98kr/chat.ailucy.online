#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
TARGET_GROUP="$(id -gn "${TARGET_USER}")"
HERMES_HOME="${TARGET_HOME}/.hermes"
HERMES_BIN="${HERMES_HOME}/hermes-agent/venv/bin/hermes"
ENV_FILE="${HERMES_HOME}/.env"
UNIT_FILE="/etc/systemd/system/hermes-gateway.service"
DOCKER_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
API_PORT="${HERMES_API_PORT:-8642}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${HERMES_HOME}/api-install-backups/${STAMP}"
HEALTH_FILE="/tmp/hermes-api-health-${STAMP}.json"

[[ -n "${TARGET_HOME}" ]] || { echo 'Could not determine target home.' >&2; exit 1; }
[[ -x "${HERMES_BIN}" ]] || { echo "Hermes executable not found: ${HERMES_BIN}" >&2; exit 1; }
[[ -n "${DOCKER_GATEWAY}" ]] || { echo 'Could not determine Docker bridge gateway.' >&2; exit 1; }

ENV_EXISTED=0
UNIT_EXISTED=0
SERVICE_WAS_ACTIVE=0
SERVICE_WAS_ENABLED=0
INSTALL_COMMITTED=0

sudo install -d -m 0700 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${BACKUP_DIR}"

if [[ -f "${ENV_FILE}" ]]; then
  ENV_EXISTED=1
  sudo cp -a "${ENV_FILE}" "${BACKUP_DIR}/hermes.env.before"
fi

if [[ -f "${UNIT_FILE}" ]]; then
  UNIT_EXISTED=1
  sudo cp -a "${UNIT_FILE}" "${BACKUP_DIR}/hermes-gateway.service.before"
fi

if sudo systemctl is-active --quiet hermes-gateway.service; then
  SERVICE_WAS_ACTIVE=1
fi
if sudo systemctl is-enabled --quiet hermes-gateway.service 2>/dev/null; then
  SERVICE_WAS_ENABLED=1
fi

rollback() {
  local rc="${1:-1}"
  trap - ERR INT TERM
  set +e

  if [[ "${INSTALL_COMMITTED}" -eq 1 ]]; then
    exit "${rc}"
  fi

  echo 'Hermes API installation failed; restoring previous state.' >&2
  sudo systemctl stop hermes-gateway.service >/dev/null 2>&1 || true

  if [[ "${UNIT_EXISTED}" -eq 1 ]]; then
    sudo cp -a "${BACKUP_DIR}/hermes-gateway.service.before" "${UNIT_FILE}"
  else
    sudo rm -f "${UNIT_FILE}"
  fi
  sudo systemctl daemon-reload >/dev/null 2>&1 || true

  if [[ "${SERVICE_WAS_ENABLED}" -eq 1 ]]; then
    sudo systemctl enable hermes-gateway.service >/dev/null 2>&1 || true
  else
    sudo systemctl disable hermes-gateway.service >/dev/null 2>&1 || true
  fi

  if [[ "${SERVICE_WAS_ACTIVE}" -eq 1 ]]; then
    sudo systemctl start hermes-gateway.service >/dev/null 2>&1 || true
  fi

  if [[ "${ENV_EXISTED}" -eq 1 ]]; then
    sudo cp -a "${BACKUP_DIR}/hermes.env.before" "${ENV_FILE}"
  else
    sudo rm -f "${ENV_FILE}"
  fi

  sudo chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BACKUP_DIR}" >/dev/null 2>&1 || true
  rm -f "${HEALTH_FILE}" >/dev/null 2>&1 || true
  echo "Rollback evidence retained in ${BACKUP_DIR}" >&2
  exit "${rc}"
}

trap 'rollback $?' ERR
trap 'rollback 130' INT TERM

printf 'Installing Hermes native API for user %s\n' "${TARGET_USER}"
printf 'Docker-only bind: %s:%s\n' "${DOCKER_GATEWAY}" "${API_PORT}"
printf 'Rollback backup: %s\n' "${BACKUP_DIR}"

sudo install -d -m 0700 -o "${TARGET_USER}" -g "${TARGET_GROUP}" "${HERMES_HOME}"
sudo -u "${TARGET_USER}" touch "${ENV_FILE}"
sudo chmod 0600 "${ENV_FILE}"

EXISTING_KEY="$(sudo -u "${TARGET_USER}" sed -n 's/^API_SERVER_KEY=//p' "${ENV_FILE}" | tail -n 1)"
if [[ -z "${EXISTING_KEY}" ]]; then
  EXISTING_KEY="$(openssl rand -hex 32)"
fi

sudo -u "${TARGET_USER}" python3 - "${ENV_FILE}" "${DOCKER_GATEWAY}" "${API_PORT}" "${EXISTING_KEY}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
values = {
    "API_SERVER_ENABLED": "true",
    "API_SERVER_HOST": sys.argv[2],
    "API_SERVER_PORT": sys.argv[3],
    "API_SERVER_KEY": sys.argv[4],
    "API_SERVER_MODEL_NAME": "hermes-agent",
}

lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
seen = set()
out = []
for line in lines:
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#") or "=" not in line:
        out.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in values:
        if key not in seen:
            out.append(f"{key}={values[key]}")
            seen.add(key)
        continue
    out.append(line)
for key, value in values.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
PY

sudo chmod 0600 "${ENV_FILE}"
sudo chown "${TARGET_USER}:${TARGET_GROUP}" "${ENV_FILE}"

sudo tee "${UNIT_FILE}" >/dev/null <<UNIT
[Unit]
Description=Hermes Agent Gateway with native OpenAI API
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_GROUP}
WorkingDirectory=${TARGET_HOME}
Environment=HOME=${TARGET_HOME}
Environment=USER=${TARGET_USER}
Environment=LOGNAME=${TARGET_USER}
Environment=HERMES_HOME=${HERMES_HOME}
Environment=PATH=${HERMES_HOME}/hermes-agent/venv/bin:${TARGET_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${HERMES_BIN} gateway run --replace
Restart=on-failure
RestartSec=10
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now hermes-gateway.service

for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 \
    -H "Authorization: Bearer ${EXISTING_KEY}" \
    "http://${DOCKER_GATEWAY}:${API_PORT}/health" >"${HEALTH_FILE}"; then
    cat "${HEALTH_FILE}"
    echo
    INSTALL_COMMITTED=1
    trap - ERR INT TERM
    rm -f "${HEALTH_FILE}"
    sudo chown -R "${TARGET_USER}:${TARGET_GROUP}" "${BACKUP_DIR}"
    echo "Hermes API ready on Docker gateway ${DOCKER_GATEWAY}:${API_PORT}."
    echo "API key remains in ${ENV_FILE}; it was not printed."
    echo "Rollback backup retained in ${BACKUP_DIR}."
    exit 0
  fi
  sleep 1
done

echo 'Hermes gateway did not become healthy.' >&2
sudo systemctl --no-pager --full status hermes-gateway.service >&2 || true
sudo journalctl -u hermes-gateway.service -n 80 --no-pager >&2 || true
rollback 1
