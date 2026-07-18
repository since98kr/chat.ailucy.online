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

[[ -n "${TARGET_HOME}" ]] || { echo 'Could not determine target home.' >&2; exit 1; }
[[ -x "${HERMES_BIN}" ]] || { echo "Hermes executable not found: ${HERMES_BIN}" >&2; exit 1; }
[[ -n "${DOCKER_GATEWAY}" ]] || { echo 'Could not determine Docker bridge gateway.' >&2; exit 1; }

printf 'Installing Hermes native API for user %s\n' "${TARGET_USER}"
printf 'Docker-only bind: %s:%s\n' "${DOCKER_GATEWAY}" "${API_PORT}"

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
    "http://${DOCKER_GATEWAY}:${API_PORT}/health" >/tmp/hermes-api-health.json; then
    cat /tmp/hermes-api-health.json
    echo
    echo "Hermes API ready on Docker gateway ${DOCKER_GATEWAY}:${API_PORT}."
    echo "API key remains in ${ENV_FILE}; it was not printed."
    exit 0
  fi
  sleep 1
done

echo 'Hermes gateway did not become healthy.' >&2
sudo systemctl --no-pager --full status hermes-gateway.service >&2 || true
sudo journalctl -u hermes-gateway.service -n 80 --no-pager >&2 || true
exit 1
