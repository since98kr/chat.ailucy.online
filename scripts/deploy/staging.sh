#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_ROOT="${CHAT_STAGING_ROOT:-/opt/chat-v2/staging}"
DATA_DIR="${CHAT_STAGING_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
STATE_FILE="${STATE_DIR}/current-image"
PORT="${CHAT_STAGING_PORT:-14174}"
BACKUP_RETENTION="${CHAT_BACKUP_RETENTION:-10}"
HERMES_DOCKER_NETWORK="${HERMES_DOCKER_NETWORK:-}"
REVISION="${1:-${GITHUB_SHA:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}}"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
IMAGE="chat-ailucy-v2:${REVISION}"
PREVIOUS_IMAGE=""
BACKUP_ID=""

log() {
  printf '[chat-v2-staging] %s\n' "$*"
}

cleanup_failed_image() {
  docker image inspect "${IMAGE}" >/dev/null 2>&1 && docker image rm "${IMAGE}" >/dev/null 2>&1 || true
}

connect_adapter_network() {
  if [[ -z "${HERMES_DOCKER_NETWORK}" ]]; then
    return
  fi

  docker network inspect "${HERMES_DOCKER_NETWORK}" >/dev/null 2>&1 \
    || { log "Hermes Docker network not found: ${HERMES_DOCKER_NETWORK}."; false; }

  if ! docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' chat-v2-staging \
    | grep -Fxq "${HERMES_DOCKER_NETWORK}"; then
    docker network connect "${HERMES_DOCKER_NETWORK}" chat-v2-staging
  fi

  log "Connected staging service to adapter network ${HERMES_DOCKER_NETWORK}."
}

rollback() {
  log 'Deployment failed. Starting rollback.'
  docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" logs --tail=120 || true
  if [[ -n "${PREVIOUS_IMAGE}" ]] && docker image inspect "${PREVIOUS_IMAGE}" >/dev/null 2>&1; then
    export CHAT_IMAGE="${PREVIOUS_IMAGE}"
    docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans
    connect_adapter_network || true
    log "Rolled back to ${PREVIOUS_IMAGE}."
  else
    docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" down || true
    log 'No previous image was available; staging service was stopped.'
  fi
  cleanup_failed_image
}

trap rollback ERR

command -v docker >/dev/null
docker compose version >/dev/null
mkdir -p "${DATA_DIR}" "${STATE_DIR}" "${DATA_DIR}/artifacts" "${DATA_DIR}/backups"
export CHAT_RUNTIME_UID="${CHAT_RUNTIME_UID:-$(stat -c '%u' "${DATA_DIR}")}"
export CHAT_RUNTIME_GID="${CHAT_RUNTIME_GID:-$(stat -c '%g' "${DATA_DIR}")}"
export CHAT_ENVIRONMENT=staging

if [[ -f "${STATE_FILE}" ]]; then
  PREVIOUS_IMAGE="$(<"${STATE_FILE}")"
fi

log "Building ${IMAGE} (${VERSION}, ${BUILD_TIME})."
docker build --pull \
  --build-arg "CHAT_BUILD_SHA=${REVISION}" \
  --build-arg "CHAT_BUILD_TIME=${BUILD_TIME}" \
  --build-arg "CHAT_VERSION=${VERSION}" \
  --tag "${IMAGE}" \
  "${REPO_ROOT}"

log 'Running strict host and adapter preflight.'
bash "${REPO_ROOT}/scripts/ops/staging-preflight.sh" "${IMAGE}" "${REVISION}" >"${STATE_DIR}/last-preflight-output.log"

if [[ -f "${DATA_DIR}/chat-v2.sqlite" ]]; then
  log 'Creating and verifying a pre-deployment backup.'
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
    "${IMAGE}" node dist-server/backup.js verify "/data/backups/${BACKUP_ID}" >"${STATE_DIR}/last-backup-verify.json"
  node -e "const j=require('${STATE_DIR}/last-backup-verify.json');if(!j.ok)process.exit(1)"
  log "Backup verified: ${BACKUP_ID}."
else
  printf '%s\n' '{"skipped":true,"reason":"database-not-created"}' >"${STATE_DIR}/last-backup.json"
  log 'No existing database; pre-deployment backup skipped.'
fi

export CHAT_IMAGE="${IMAGE}"
export CHAT_STAGING_DATA_DIR="${DATA_DIR}"
export CHAT_STAGING_PORT="${PORT}"

log "Starting isolated staging service on 127.0.0.1:${PORT} as ${CHAT_RUNTIME_UID}:${CHAT_RUNTIME_GID}."
docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans
connect_adapter_network

log 'Waiting for application health.'
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

if [[ "${healthy}" != '1' ]]; then
  log 'Health check did not pass.'
  false
fi

RUNNING_REVISION="$(docker exec chat-v2-staging node -e "process.stdout.write(process.env.CHAT_BUILD_SHA||'')")"
if [[ "${RUNNING_REVISION}" != "${REVISION}" ]]; then
  log "Running revision mismatch: expected ${REVISION}, found ${RUNNING_REVISION:-missing}."
  false
fi

AUTH_ARGS=()
case "${CHAT_AUTH_MODE:-disabled}" in
  token)
    AUTH_ARGS+=(--header "Authorization: Bearer ${CHAT_ACCESS_TOKEN:?CHAT_ACCESS_TOKEN is required}")
    ;;
  cloudflare)
    FIRST_ALLOWED_EMAIL="${CHAT_ALLOWED_EMAILS%%,*}"
    [[ -n "${FIRST_ALLOWED_EMAIL}" ]] || { log 'CHAT_ALLOWED_EMAILS is required for Cloudflare mode.'; false; }
    AUTH_ARGS+=(--header "Cf-Access-Authenticated-User-Email: ${FIRST_ALLOWED_EMAIL}")
    ;;
esac

curl --fail --silent --show-error "${AUTH_ARGS[@]}" \
  "http://127.0.0.1:${PORT}/api/ops/status" >"${STATE_DIR}/last-ops-status.json"
node -e "const j=require('${STATE_DIR}/last-ops-status.json');if(!j.ok||j.build.sha!=='${REVISION}')process.exit(1)"

printf '%s' "${IMAGE}" >"${STATE_FILE}"
printf '%s' "${REVISION}" >"${STATE_DIR}/current-revision"
node - "${STATE_DIR}/last-deployment.json" "${REVISION}" "${VERSION}" "${BUILD_TIME}" "${IMAGE}" "${PREVIOUS_IMAGE}" "${BACKUP_ID}" <<'NODE'
const [path, revision, version, builtAt, image, previousImage, backupId] = process.argv.slice(2);
require('node:fs').writeFileSync(path, JSON.stringify({
  ok: true,
  revision,
  version,
  builtAt,
  image,
  previousImage: previousImage || null,
  backupId: backupId || null,
  deployedAt: new Date().toISOString(),
}, null, 2) + '\n');
NODE
trap - ERR

log "Staging deployment completed: ${IMAGE}."
if [[ -n "${PREVIOUS_IMAGE}" && "${PREVIOUS_IMAGE}" != "${IMAGE}" ]]; then
  log "Previous rollback image retained: ${PREVIOUS_IMAGE}."
fi
