#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_ROOT="${CHAT_STAGING_ROOT:-/opt/chat-v2/staging}"
DATA_DIR="${CHAT_STAGING_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
STATE_FILE="${STATE_DIR}/current-image"
PORT="${CHAT_STAGING_PORT:-14174}"
REVISION="${1:-${GITHUB_SHA:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}}"
IMAGE="chat-ailucy-v2:${REVISION}"
PREVIOUS_IMAGE=""

log() {
  printf '[chat-v2-staging] %s\n' "$*"
}

cleanup_failed_image() {
  docker image inspect "${IMAGE}" >/dev/null 2>&1 && docker image rm "${IMAGE}" >/dev/null 2>&1 || true
}

rollback() {
  log "Deployment failed. Starting rollback."
  docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" logs --tail=120 || true
  if [[ -n "${PREVIOUS_IMAGE}" ]] && docker image inspect "${PREVIOUS_IMAGE}" >/dev/null 2>&1; then
    export CHAT_IMAGE="${PREVIOUS_IMAGE}"
    docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans
    log "Rolled back to ${PREVIOUS_IMAGE}."
  else
    docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" down || true
    log "No previous image was available; staging service was stopped."
  fi
  cleanup_failed_image
}

trap rollback ERR

command -v docker >/dev/null

docker compose version >/dev/null
mkdir -p "${DATA_DIR}" "${STATE_DIR}"

if [[ -f "${STATE_FILE}" ]]; then
  PREVIOUS_IMAGE="$(<"${STATE_FILE}")"
fi

log "Building ${IMAGE}."
docker build --pull --tag "${IMAGE}" "${REPO_ROOT}"

export CHAT_IMAGE="${IMAGE}"
export CHAT_STAGING_DATA_DIR="${DATA_DIR}"
export CHAT_STAGING_PORT="${PORT}"

log "Starting isolated staging service on 127.0.0.1:${PORT}."
docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans

log "Waiting for application health."
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/health" >"${STATE_DIR}/last-health.json"; then
    if node -e "const j=require('${STATE_DIR}/last-health.json');if(!j.ok)process.exit(1)"; then
      healthy=1
      break
    fi
  fi
  sleep 2
done

if [[ "${healthy}" != "1" ]]; then
  log "Health check did not pass."
  false
fi

printf '%s' "${IMAGE}" >"${STATE_FILE}"
printf '%s' "${REVISION}" >"${STATE_DIR}/current-revision"
trap - ERR

log "Staging deployment completed: ${IMAGE}."
if [[ -n "${PREVIOUS_IMAGE}" && "${PREVIOUS_IMAGE}" != "${IMAGE}" ]]; then
  log "Previous rollback image retained: ${PREVIOUS_IMAGE}."
fi
