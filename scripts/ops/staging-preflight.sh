#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${1:?Usage: staging-preflight.sh <image> [expected-revision]}"
EXPECTED_REVISION="${2:-}"
DEPLOY_ROOT="${CHAT_STAGING_ROOT:-/opt/chat-v2/staging}"
DATA_DIR="${CHAT_STAGING_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
PORT="${CHAT_STAGING_PORT:-14174}"
STRICT="${CHAT_PREFLIGHT_STRICT:-true}"
HERMES_DOCKER_NETWORK="${HERMES_DOCKER_NETWORK:-}"

log() {
  printf '[chat-v2-preflight] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

command -v docker >/dev/null || fail 'docker is not installed'
docker compose version >/dev/null || fail 'docker compose is unavailable'
docker info >/dev/null || fail 'the current user cannot access Docker'
docker image inspect "${IMAGE}" >/dev/null || fail "image not found: ${IMAGE}"

if [[ -n "${HERMES_DOCKER_NETWORK}" ]]; then
  docker network inspect "${HERMES_DOCKER_NETWORK}" >/dev/null 2>&1 \
    || fail "Hermes Docker network not found: ${HERMES_DOCKER_NETWORK}"
fi

mkdir -p "${DATA_DIR}/artifacts" "${DATA_DIR}/backups" "${STATE_DIR}"
test -r "${DATA_DIR}" -a -w "${DATA_DIR}" -a -x "${DATA_DIR}" || fail "data directory is not usable: ${DATA_DIR}"

RUNTIME_UID="${CHAT_RUNTIME_UID:-$(stat -c '%u' "${DATA_DIR}")}"
RUNTIME_GID="${CHAT_RUNTIME_GID:-$(stat -c '%g' "${DATA_DIR}")}"
IMAGE_REVISION="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${IMAGE}" | sed -n 's/^CHAT_BUILD_SHA=//p' | head -n 1)"

if [[ -n "${EXPECTED_REVISION}" && "${IMAGE_REVISION}" != "${EXPECTED_REVISION}" ]]; then
  fail "image revision mismatch: expected ${EXPECTED_REVISION}, found ${IMAGE_REVISION:-missing}"
fi

if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${PORT}" | tail -n +2 | grep -q .; then
  if ! docker ps --format '{{.Names}}' | grep -qx 'chat-v2-staging'; then
    fail "localhost port ${PORT} is already used by another process"
  fi
fi

ENV_VARS=(
  CHAT_ENVIRONMENT CHAT_PUBLIC_ORIGIN CHAT_ALLOWED_ORIGIN CHAT_AUTH_MODE CHAT_ALLOWED_EMAILS CHAT_ACCESS_TOKEN
  CHAT_RATE_LIMIT_GENERAL CHAT_RATE_LIMIT_CHAT CHAT_RATE_LIMIT_UPLOAD CHAT_PREFLIGHT_MIN_FREE_BYTES
  LETTA_BASE_URL LETTA_CHAT_PATH LETTA_HEALTH_PATH LETTA_AGENT_ID LETTA_API_KEY LETTA_TIMEOUT_MS
  HERMES_BASE_URL HERMES_CHAT_PATH HERMES_HEALTH_PATH HERMES_AGENT_ID HERMES_API_KEY HERMES_TIMEOUT_MS
)
DOCKER_ENV=(
  --env CHAT_DB_PATH=/data/chat-v2.sqlite
  --env CHAT_ARTIFACT_ROOT=/data/artifacts
  --env CHAT_BACKUP_ROOT=/data/backups
  --env "CHAT_PREFLIGHT_REQUIRE_AUTH=${STRICT}"
  --env "CHAT_PREFLIGHT_REQUIRE_REAL_ADAPTERS=${STRICT}"
)
for name in "${ENV_VARS[@]}"; do
  if [[ -n "${!name-}" ]]; then
    DOCKER_ENV+=(--env "${name}")
  fi
done

DOCKER_NETWORK_ARGS=()
if [[ -n "${HERMES_DOCKER_NETWORK}" ]]; then
  DOCKER_NETWORK_ARGS+=(--network "${HERMES_DOCKER_NETWORK}")
fi

ARGS=()
if [[ "${STRICT}" == 'true' ]]; then
  ARGS+=(--strict)
fi

log "Running exact-runtime preflight for ${IMAGE} as ${RUNTIME_UID}:${RUNTIME_GID}."
set +e
docker run --rm \
  "${DOCKER_NETWORK_ARGS[@]}" \
  --user "${RUNTIME_UID}:${RUNTIME_GID}" \
  --volume "${DATA_DIR}:/data" \
  "${DOCKER_ENV[@]}" \
  "${IMAGE}" node dist-server/preflight.js "${ARGS[@]}" >"${STATE_DIR}/last-preflight.json"
STATUS=$?
set -e

if ! node -e "const j=require('${STATE_DIR}/last-preflight.json');if(typeof j.ok!=='boolean')process.exit(1)"; then
  fail 'preflight did not produce a valid JSON report'
fi

if [[ "${STATUS}" -ne 0 ]] || ! node -e "const j=require('${STATE_DIR}/last-preflight.json');if(!j.ok)process.exit(1)"; then
  cat "${STATE_DIR}/last-preflight.json"
  fail 'runtime preflight failed'
fi

log "Preflight passed for revision ${IMAGE_REVISION:-unknown}."
cat "${STATE_DIR}/last-preflight.json"
