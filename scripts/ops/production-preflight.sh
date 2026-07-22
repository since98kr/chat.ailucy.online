#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${1:?Usage: production-preflight.sh <image> <expected-revision>}"
EXPECTED_REVISION="${2:?Expected immutable revision is required}"
DEPLOY_ROOT="${CHAT_PRODUCTION_ROOT:-/opt/chat-v2/production}"
DATA_DIR="${CHAT_PRODUCTION_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
PORT="${CHAT_PRODUCTION_PORT:?CHAT_PRODUCTION_PORT is required}"
CONTAINER_NAME="${CHAT_PRODUCTION_CONTAINER_NAME:-chat-v2-production}"
STRICT="${CHAT_PREFLIGHT_STRICT:-true}"
HERMES_DOCKER_NETWORK="${HERMES_DOCKER_NETWORK:-}"

log() {
  printf '[chat-v2-production-preflight] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ "${EXPECTED_REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail 'expected revision must be a full 40-character commit SHA'
[[ "${STRICT}" == 'true' ]] || fail 'production preflight must run in strict mode'
[[ "${CHAT_ENVIRONMENT:-production}" == 'production' ]] || fail 'CHAT_ENVIRONMENT must be production'

command -v docker >/dev/null || fail 'docker is not installed'
docker compose version >/dev/null || fail 'docker compose is unavailable'
docker info >/dev/null || fail 'the current user cannot access Docker'
docker image inspect "${IMAGE}" >/dev/null || fail "image not found: ${IMAGE}"

DEPLOY_ROOT_REAL="$(realpath -m "${DEPLOY_ROOT}")"
DATA_DIR_REAL="$(realpath -m "${DATA_DIR}")"
case "${DEPLOY_ROOT_REAL}" in
  /opt/chat-v2/staging|/opt/chat-v2/staging/*) fail 'production root must not reuse the staging root' ;;
esac
case "${DATA_DIR_REAL}" in
  /opt/chat-v2/staging|/opt/chat-v2/staging/*) fail 'production data must not reuse the staging data root' ;;
esac
[[ "${DATA_DIR_REAL}" == "${DEPLOY_ROOT_REAL}"/* ]] || fail 'production data directory must be contained within the production root'

if [[ -n "${HERMES_DOCKER_NETWORK}" ]]; then
  docker network inspect "${HERMES_DOCKER_NETWORK}" >/dev/null 2>&1 \
    || fail "Hermes Docker network not found: ${HERMES_DOCKER_NETWORK}"
fi

mkdir -p "${DATA_DIR}/artifacts" "${DATA_DIR}/backups" "${STATE_DIR}"
test -r "${DATA_DIR}" -a -w "${DATA_DIR}" -a -x "${DATA_DIR}" || fail "data directory is not usable: ${DATA_DIR}"

RUNTIME_UID="${CHAT_RUNTIME_UID:-$(stat -c '%u' "${DATA_DIR}")}"
RUNTIME_GID="${CHAT_RUNTIME_GID:-$(stat -c '%g' "${DATA_DIR}")}"
IMAGE_REVISION="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${IMAGE}" | sed -n 's/^CHAT_BUILD_SHA=//p' | head -n 1)"

[[ "${IMAGE_REVISION}" == "${EXPECTED_REVISION}" ]] \
  || fail "image revision mismatch: expected ${EXPECTED_REVISION}, found ${IMAGE_REVISION:-missing}"

if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${PORT}" | tail -n +2 | grep -q .; then
  if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    fail "localhost port ${PORT} is already used by another process"
  fi
fi

ENV_VARS=(
  CHAT_ENVIRONMENT CHAT_PUBLIC_ORIGIN CHAT_ALLOWED_ORIGIN CHAT_AUTH_MODE CHAT_ALLOWED_EMAILS
  CHAT_ALLOWED_SERVICE_CLIENT_IDS CHAT_CF_ACCESS_ISSUER CHAT_CF_ACCESS_AUD CHAT_ACCESS_TOKEN
  CHAT_RATE_LIMIT_GENERAL CHAT_RATE_LIMIT_CHAT CHAT_RATE_LIMIT_UPLOAD CHAT_PREFLIGHT_MIN_FREE_BYTES
  CHAT_MAX_UPLOAD_BYTES CHAT_MAX_GENERATED_ARTIFACT_BYTES CHAT_MAX_INLINE_GENERATED_ARTIFACT_PAYLOAD_BYTES
  CHAT_MAX_EXTRACTED_TEXT_CHARACTERS CHAT_MAX_PDF_PAGES
  LETTA_BASE_URL LETTA_CHAT_PATH LETTA_HEALTH_PATH LETTA_AGENT_ID LETTA_API_KEY LETTA_TIMEOUT_MS
  LETTA_PROTOCOL LETTA_MODEL_MAP_JSON LETTA_MAX_ARTIFACT_BYTES LETTA_MAX_ARTIFACT_TOTAL_BYTES
  LETTA_MAX_TEXT_ARTIFACT_BYTES LETTA_NATIVE_BINARY_ARTIFACTS LETTA_ARTIFACT_TOOL_ENABLED
  HERMES_BASE_URL HERMES_CHAT_PATH HERMES_HEALTH_PATH HERMES_AGENT_ID HERMES_API_KEY HERMES_TIMEOUT_MS
  HERMES_PROTOCOL HERMES_MODEL_MAP_JSON HERMES_MAX_ARTIFACT_BYTES HERMES_MAX_ARTIFACT_TOTAL_BYTES
  HERMES_ARTIFACT_TOOL_ENABLED HERMES_ARTIFACT_ENVELOPE_ENABLED
)
DOCKER_ENV=(
  --env CHAT_DB_PATH=/data/chat-v2.sqlite
  --env CHAT_ARTIFACT_ROOT=/data/artifacts
  --env CHAT_BACKUP_ROOT=/data/backups
  --env CHAT_PREFLIGHT_REQUIRE_AUTH=true
  --env CHAT_PREFLIGHT_REQUIRE_REAL_ADAPTERS=true
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

log "Running exact production preflight for ${IMAGE} as ${RUNTIME_UID}:${RUNTIME_GID}."
set +e
docker run --rm \
  "${DOCKER_NETWORK_ARGS[@]}" \
  --add-host 'host.docker.internal:host-gateway' \
  --user "${RUNTIME_UID}:${RUNTIME_GID}" \
  --volume "${DATA_DIR}:/data" \
  "${DOCKER_ENV[@]}" \
  "${IMAGE}" node dist-server/preflight.js --strict >"${STATE_DIR}/last-preflight.json"
STATUS=$?
set -e

if ! node -e "const j=require('${STATE_DIR}/last-preflight.json');if(typeof j.ok!=='boolean')process.exit(1)"; then
  fail 'preflight did not produce a valid JSON report'
fi

if [[ "${STATUS}" -ne 0 ]] || ! node -e "const j=require('${STATE_DIR}/last-preflight.json');if(!j.ok)process.exit(1)"; then
  cat "${STATE_DIR}/last-preflight.json"
  fail 'production runtime preflight failed'
fi

node - "${STATE_DIR}/last-production-readiness.json" "${EXPECTED_REVISION}" "${IMAGE}" "${DATA_DIR_REAL}" "${PORT}" <<'NODE'
const fs = require('node:fs');
const [path, revision, image, dataDir, port] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  ok: true,
  mode: 'preflight',
  revision,
  image,
  dataDir,
  port: Number(port),
  checkedAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE

log "Production preflight passed for revision ${IMAGE_REVISION}."
cat "${STATE_DIR}/last-preflight.json"
