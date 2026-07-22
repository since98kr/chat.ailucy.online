#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${CHAT_PRODUCTION_MODE:-preflight}"
REVISION="${1:?Usage: production.sh <full-commit-sha>}"
DEPLOY_ROOT="${CHAT_PRODUCTION_ROOT:-/opt/chat-v2/production}"
DATA_DIR="${CHAT_PRODUCTION_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
STATE_FILE="${STATE_DIR}/current-image"
PORT="${CHAT_PRODUCTION_PORT:?CHAT_PRODUCTION_PORT is required}"
CONTAINER_NAME="${CHAT_PRODUCTION_CONTAINER_NAME:-chat-v2-production}"
PROJECT_NAME="${CHAT_PRODUCTION_COMPOSE_PROJECT:-chat-v2-production}"
BACKUP_RETENTION="${CHAT_BACKUP_RETENTION:-14}"
HERMES_DOCKER_NETWORK="${HERMES_DOCKER_NETWORK:-}"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
IMAGE="chat-ailucy-v2:production-${REVISION}"
PREVIOUS_IMAGE=""
BACKUP_ID=""
REPLACEMENT_STARTED=false

log() {
  printf '[chat-v2-production] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ "${MODE}" == 'preflight' || "${MODE}" == 'deploy' ]] || fail 'CHAT_PRODUCTION_MODE must be preflight or deploy'
[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full 40-character commit SHA'
[[ "$(git -C "${REPO_ROOT}" rev-parse HEAD)" == "${REVISION}" ]] || fail 'checked-out source does not match requested revision'
[[ "${CHAT_ENVIRONMENT:-production}" == 'production' ]] || fail 'CHAT_ENVIRONMENT must be production'

mkdir -p "${DATA_DIR}" "${STATE_DIR}" "${DATA_DIR}/artifacts" "${DATA_DIR}/backups"
export CHAT_RUNTIME_UID="${CHAT_RUNTIME_UID:-$(stat -c '%u' "${DATA_DIR}")}"
export CHAT_RUNTIME_GID="${CHAT_RUNTIME_GID:-$(stat -c '%g' "${DATA_DIR}")}"
export CHAT_ENVIRONMENT=production

if [[ -f "${STATE_FILE}" ]]; then
  PREVIOUS_IMAGE="$(<"${STATE_FILE}")"
fi

cleanup_candidate_image() {
  if [[ "${IMAGE}" != "${PREVIOUS_IMAGE}" ]]; then
    docker image inspect "${IMAGE}" >/dev/null 2>&1 && docker image rm "${IMAGE}" >/dev/null 2>&1 || true
  fi
}

connect_adapter_network() {
  if [[ -z "${HERMES_DOCKER_NETWORK}" ]]; then
    return
  fi
  docker network inspect "${HERMES_DOCKER_NETWORK}" >/dev/null 2>&1 \
    || { log "Hermes Docker network not found: ${HERMES_DOCKER_NETWORK}."; false; }
  if ! docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "${CONTAINER_NAME}" \
    | grep -Fxq "${HERMES_DOCKER_NETWORK}"; then
    docker network connect "${HERMES_DOCKER_NETWORK}" "${CONTAINER_NAME}"
  fi
}

rollback() {
  local exit_code=$?
  if [[ "${REPLACEMENT_STARTED}" != 'true' ]]; then
    cleanup_candidate_image
    exit "${exit_code}"
  fi

  log 'Production replacement failed. Starting project-scoped rollback.'
  docker compose -p "${PROJECT_NAME}" -f "${REPO_ROOT}/compose.production.yml" logs --tail=160 || true
  if [[ -n "${PREVIOUS_IMAGE}" ]] && docker image inspect "${PREVIOUS_IMAGE}" >/dev/null 2>&1; then
    export CHAT_IMAGE="${PREVIOUS_IMAGE}"
    docker compose -p "${PROJECT_NAME}" -f "${REPO_ROOT}/compose.production.yml" up -d --remove-orphans
    connect_adapter_network || true
    log "Rolled back to ${PREVIOUS_IMAGE}."
  else
    docker compose -p "${PROJECT_NAME}" -f "${REPO_ROOT}/compose.production.yml" down || true
    log 'No previous production image was available; only the production Compose project was stopped.'
  fi
  cleanup_candidate_image
  exit "${exit_code}"
}
trap rollback ERR

command -v docker >/dev/null

docker compose version >/dev/null

log "Building immutable candidate ${IMAGE} (${VERSION}, ${BUILD_TIME})."
docker build --pull \
  --build-arg "CHAT_BUILD_SHA=${REVISION}" \
  --build-arg "CHAT_BUILD_TIME=${BUILD_TIME}" \
  --build-arg "CHAT_VERSION=${VERSION}" \
  --tag "${IMAGE}" \
  "${REPO_ROOT}"

log 'Running strict production preflight before any replacement.'
bash "${REPO_ROOT}/scripts/ops/production-preflight.sh" "${IMAGE}" "${REVISION}" \
  >"${STATE_DIR}/last-preflight-output.log"

if [[ "${MODE}" == 'preflight' ]]; then
  trap - ERR
  log "Preflight-only mode completed. No production service was replaced: ${IMAGE}."
  exit 0
fi

[[ "${CHAT_PRODUCTION_CONFIRM:-}" == 'DEPLOY_CHAT_V2_PRODUCTION' ]] \
  || fail 'CHAT_PRODUCTION_CONFIRM must equal DEPLOY_CHAT_V2_PRODUCTION'
[[ "${CHAT_PRODUCTION_APPROVED_SHA:-}" == "${REVISION}" ]] \
  || fail 'CHAT_PRODUCTION_APPROVED_SHA must equal the requested revision'

if [[ -f "${DATA_DIR}/chat-v2.sqlite" ]]; then
  log 'Creating and verifying the production pre-deployment backup.'
  docker run --rm \
    --user "${CHAT_RUNTIME_UID}:${CHAT_RUNTIME_GID}" \
    --volume "${DATA_DIR}:/data" \
    --env CHAT_DB_PATH=/data/chat-v2.sqlite \
    --env CHAT_ARTIFACT_ROOT=/data/artifacts \
    --env CHAT_BACKUP_ROOT=/data/backups \
    --env CHAT_BACKUP_RETENTION="${BACKUP_RETENTION}" \
    "${IMAGE}" node dist-server/backup.js create >"${STATE_DIR}/last-backup.json"
  BACKUP_ID="$(node -e "const j=require('${STATE_DIR}/last-backup.json');if(!j.id)process.exit(1);process.stdout.write(j.id)")"
  docker run --rm \
    --user "${CHAT_RUNTIME_UID}:${CHAT_RUNTIME_GID}" \
    --volume "${DATA_DIR}:/data:ro" \
    "${IMAGE}" node dist-server/backup.js verify "/data/backups/${BACKUP_ID}" \
    >"${STATE_DIR}/last-backup-verify.json"
  node -e "const j=require('${STATE_DIR}/last-backup-verify.json');if(!j.ok)process.exit(1)"
  log "Production backup verified: ${BACKUP_ID}."
else
  printf '%s\n' '{"skipped":true,"reason":"database-not-created"}' >"${STATE_DIR}/last-backup.json"
  log 'No existing production database; backup skipped.'
fi

export CHAT_IMAGE="${IMAGE}"
export CHAT_PRODUCTION_DATA_DIR="${DATA_DIR}"
export CHAT_PRODUCTION_PORT="${PORT}"
export CHAT_PRODUCTION_CONTAINER_NAME="${CONTAINER_NAME}"
REPLACEMENT_STARTED=true

log "Starting production Compose project ${PROJECT_NAME} on 127.0.0.1:${PORT}."
docker compose -p "${PROJECT_NAME}" -f "${REPO_ROOT}/compose.production.yml" up -d --remove-orphans
connect_adapter_network

log 'Waiting for production health.'
healthy=0
for attempt in $(seq 1 45); do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/health" >"${STATE_DIR}/last-health.json"; then
    if node -e "const j=require('${STATE_DIR}/last-health.json');if(!j.ok)process.exit(1)"; then
      healthy=1
      break
    fi
  fi
  sleep 2
done
[[ "${healthy}" == '1' ]] || fail 'production health check did not pass'

RUNNING_REVISION="$(docker exec "${CONTAINER_NAME}" node -e "process.stdout.write(process.env.CHAT_BUILD_SHA||'')")"
[[ "${RUNNING_REVISION}" == "${REVISION}" ]] \
  || fail "running revision mismatch: expected ${REVISION}, found ${RUNNING_REVISION:-missing}"

AUTH_ARGS=()
case "${CHAT_AUTH_MODE:?CHAT_AUTH_MODE is required}" in
  token)
    AUTH_ARGS+=(--header "Authorization: Bearer ${CHAT_ACCESS_TOKEN:?CHAT_ACCESS_TOKEN is required}")
    ;;
  cloudflare)
    FIRST_ALLOWED_EMAIL="${CHAT_ALLOWED_EMAILS%%,*}"
    [[ -n "${FIRST_ALLOWED_EMAIL}" ]] || fail 'CHAT_ALLOWED_EMAILS is required for Cloudflare mode'
    AUTH_ARGS+=(--header "Cf-Access-Authenticated-User-Email: ${FIRST_ALLOWED_EMAIL}")
    ;;
  *) fail 'production authentication mode must be token or cloudflare' ;;
esac

curl --fail --silent --show-error "${AUTH_ARGS[@]}" \
  "http://127.0.0.1:${PORT}/api/ops/status" >"${STATE_DIR}/last-ops-status.json"
node -e "const j=require('${STATE_DIR}/last-ops-status.json');if(!j.ok||j.build.sha!=='${REVISION}')process.exit(1)"

printf '%s' "${IMAGE}" >"${STATE_FILE}"
printf '%s' "${REVISION}" >"${STATE_DIR}/current-revision"
node - "${STATE_DIR}/last-deployment.json" "${REVISION}" "${VERSION}" "${BUILD_TIME}" "${IMAGE}" "${PREVIOUS_IMAGE}" "${BACKUP_ID}" <<'NODE'
const fs = require('node:fs');
const [path, revision, version, builtAt, image, previousImage, backupId] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  ok: true,
  environment: 'production',
  revision,
  version,
  builtAt,
  image,
  previousImage: previousImage || null,
  backupId: backupId || null,
  deployedAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE

REPLACEMENT_STARTED=false
trap - ERR
log "Production deployment completed for ${REVISION}."
if [[ -n "${PREVIOUS_IMAGE}" && "${PREVIOUS_IMAGE}" != "${IMAGE}" ]]; then
  log "Previous rollback image retained: ${PREVIOUS_IMAGE}."
fi
