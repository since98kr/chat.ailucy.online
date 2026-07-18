#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_USER="${SUDO_USER:-${USER}}"
TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
REMOTE_HOST="${LETTA_SSH_HOST:-ax.hni-gl.ai}"
REMOTE_PORT="${LETTA_SSH_PORT:-3004}"
REMOTE_USER="${LETTA_SSH_USER:-since98kr}"
LOCAL_PORT="${LETTA_TUNNEL_PORT:-18283}"
DOCKER_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
SSH_BIN="$(command -v ssh)"
UNIT_FILE='/etc/systemd/system/letta-bridge-tunnel.service'

sudo -u "${TARGET_USER}" "${SSH_BIN}" \
  -p "${REMOTE_PORT}" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  "${REMOTE_USER}@${REMOTE_HOST}" true >/dev/null \
  || { echo 'Passwordless SSH is required. Run ssh-copy-id first.'; exit 1; }

sudo tee "${UNIT_FILE}" >/dev/null <<UNIT
[Unit]
Description=SSH tunnel from agentlucy Docker gateway to Lucy Letta Bridge
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=${TARGET_USER}
Group=${TARGET_USER}
Environment=HOME=${TARGET_HOME}
ExecStart=${SSH_BIN} -NT -p ${REMOTE_PORT} -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -L ${DOCKER_GATEWAY}:${LOCAL_PORT}:127.0.0.1:18283 ${REMOTE_USER}@${REMOTE_HOST}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now letta-bridge-tunnel.service
sleep 2
curl -fsS "http://${DOCKER_GATEWAY}:${LOCAL_PORT}/health"
echo
echo "Tunnel ready on Docker gateway ${DOCKER_GATEWAY}:${LOCAL_PORT}."
