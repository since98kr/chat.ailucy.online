#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_ROOT="${CHAT_STAGING_ROOT:-/opt/chat-v2/staging}"
DATA_DIR="${CHAT_STAGING_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
STATE_FILE="${STATE_DIR}/current-image"
PORT="${CHAT_STAGING_PORT:-14174}"
BACKUP_ID="${1:-}"

if [[ -z "${BACKUP_ID}" ]]; then
  echo 'Usage: CONFIRM_RESTORE=<backup-id> restore-staging.sh <backup-id>' >&2
  exit 2
fi
if [[ "${CONFIRM_RESTORE:-}" != "${BACKUP_ID}" ]]; then
  echo 'Set CONFIRM_RESTORE to the exact backup id.' >&2
  exit 2
fi
if [[ ! "${BACKUP_ID}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z$ ]]; then
  echo 'Invalid backup id format.' >&2
  exit 2
fi
if [[ ! -f "${STATE_FILE}" ]]; then
  echo "Current image state is missing: ${STATE_FILE}" >&2
  exit 1
fi

IMAGE="$(<"${STATE_FILE}")"
BACKUP_DIR="${DATA_DIR}/backups/${BACKUP_ID}"
RUNTIME_UID="${CHAT_RUNTIME_UID:-$(stat -c '%u' "${DATA_DIR}")}"
RUNTIME_GID="${CHAT_RUNTIME_GID:-$(stat -c '%g' "${DATA_DIR}")}"
RESCUE_ID="pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
RESCUE_DIR="${DATA_DIR}/recovery/${RESCUE_ID}"

[[ -d "${BACKUP_DIR}" ]] || { echo "Backup not found: ${BACKUP_DIR}" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null

log() { printf '[chat-v2-restore] %s\n' "$*"; }

log "Verifying backup ${BACKUP_ID}."
docker run --rm \
  --user "${RUNTIME_UID}:${RUNTIME_GID}" \
  --volume "${DATA_DIR}:/data:ro" \
  "${IMAGE}" node dist-server/backup.js verify "/data/backups/${BACKUP_ID}" >"${STATE_DIR}/last-restore-verify.json"
node -e "const j=require('${STATE_DIR}/last-restore-verify.json');if(!j.ok)process.exit(1)"

export CHAT_IMAGE="${IMAGE}"
export CHAT_STAGING_DATA_DIR="${DATA_DIR}"
export CHAT_STAGING_PORT="${PORT}"
export CHAT_RUNTIME_UID="${RUNTIME_UID}"
export CHAT_RUNTIME_GID="${RUNTIME_GID}"

docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" down
mkdir -p "${RESCUE_DIR}"
[[ -f "${DATA_DIR}/chat-v2.sqlite" ]] && cp -a "${DATA_DIR}/chat-v2.sqlite" "${RESCUE_DIR}/chat-v2.sqlite"
[[ -f "${DATA_DIR}/chat-v2.sqlite-wal" ]] && cp -a "${DATA_DIR}/chat-v2.sqlite-wal" "${RESCUE_DIR}/chat-v2.sqlite-wal"
[[ -f "${DATA_DIR}/chat-v2.sqlite-shm" ]] && cp -a "${DATA_DIR}/chat-v2.sqlite-shm" "${RESCUE_DIR}/chat-v2.sqlite-shm"
[[ -d "${DATA_DIR}/artifacts" ]] && cp -a "${DATA_DIR}/artifacts" "${RESCUE_DIR}/artifacts"

restore_original() {
  log 'Restored data failed health check; returning to the pre-restore data.'
  docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" down || true
  rm -f "${DATA_DIR}/chat-v2.sqlite" "${DATA_DIR}/chat-v2.sqlite-wal" "${DATA_DIR}/chat-v2.sqlite-shm"
  rm -rf "${DATA_DIR}/artifacts"
  [[ -f "${RESCUE_DIR}/chat-v2.sqlite" ]] && cp -a "${RESCUE_DIR}/chat-v2.sqlite" "${DATA_DIR}/chat-v2.sqlite"
  [[ -f "${RESCUE_DIR}/chat-v2.sqlite-wal" ]] && cp -a "${RESCUE_DIR}/chat-v2.sqlite-wal" "${DATA_DIR}/chat-v2.sqlite-wal"
  [[ -f "${RESCUE_DIR}/chat-v2.sqlite-shm" ]] && cp -a "${RESCUE_DIR}/chat-v2.sqlite-shm" "${DATA_DIR}/chat-v2.sqlite-shm"
  [[ -d "${RESCUE_DIR}/artifacts" ]] && cp -a "${RESCUE_DIR}/artifacts" "${DATA_DIR}/artifacts"
  chown -R "${RUNTIME_UID}:${RUNTIME_GID}" "${DATA_DIR}"
  docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans
}
trap restore_original ERR

rm -f "${DATA_DIR}/chat-v2.sqlite" "${DATA_DIR}/chat-v2.sqlite-wal" "${DATA_DIR}/chat-v2.sqlite-shm"
rm -rf "${DATA_DIR}/artifacts"
cp -a "${BACKUP_DIR}/chat-v2.sqlite" "${DATA_DIR}/chat-v2.sqlite"
cp -a "${BACKUP_DIR}/artifacts" "${DATA_DIR}/artifacts"
chown -R "${RUNTIME_UID}:${RUNTIME_GID}" "${DATA_DIR}"

docker compose -p chat-v2-staging -f "${REPO_ROOT}/compose.staging.yml" up -d --remove-orphans
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" >"${STATE_DIR}/last-restore-health.json"; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "${healthy}" == '1' ]]
trap - ERR
printf '%s' "${BACKUP_ID}" >"${STATE_DIR}/last-restored-backup"
log "Restore completed. Rescue copy retained at ${RESCUE_DIR}."
