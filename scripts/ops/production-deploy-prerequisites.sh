#!/usr/bin/env bash
set -Eeuo pipefail

REVISION="${1:?Usage: production-deploy-prerequisites.sh <full-sha> <output-json>}"
OUTPUT="${2:?Output JSON path is required}"
DEPLOY_ROOT="${CHAT_PRODUCTION_ROOT:-/opt/chat-v2/production}"
DATA_DIR="${CHAT_PRODUCTION_DATA_DIR:-${DEPLOY_ROOT}/data}"
STATE_DIR="${DEPLOY_ROOT}/state"
STATE_FILE="${STATE_DIR}/current-image"
DATABASE_FILE="${DATA_DIR}/chat-v2.sqlite"
ALLOW_INITIAL="${CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE:-false}"
INITIAL_APPROVED_SHA="${CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA:-}"

log() {
  printf '[production-deploy-prerequisites] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full lowercase 40-character SHA'
[[ "${ALLOW_INITIAL}" == 'true' || "${ALLOW_INITIAL}" == 'false' ]] \
  || fail 'CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE must be true or false'

DEPLOY_ROOT_REAL="$(realpath -m "${DEPLOY_ROOT}")"
DATA_DIR_REAL="$(realpath -m "${DATA_DIR}")"
case "${DEPLOY_ROOT_REAL}" in
  /opt/chat-v2/staging|/opt/chat-v2/staging/*) fail 'production root may not reuse staging' ;;
esac
[[ "${DEPLOY_ROOT_REAL}" == '/opt/chat-v2/production' || "${DEPLOY_ROOT_REAL}" == /opt/chat-v2/production/* ]] \
  || fail 'production root must be /opt/chat-v2/production or a contained path'
[[ "${DATA_DIR_REAL}" == "${DEPLOY_ROOT_REAL}"/* ]] \
  || fail 'production data directory must be contained in the production root'

mkdir -p "$(dirname "${OUTPUT}")"
[[ ! -e "${OUTPUT}" ]] || fail "output already exists: ${OUTPUT}"

MODE='standard'
PREVIOUS_IMAGE=''
DATABASE_PRESENT=false

if [[ "${ALLOW_INITIAL}" == 'true' ]]; then
  MODE='initial'
  [[ "${INITIAL_APPROVED_SHA}" == "${REVISION}" ]] \
    || fail 'initial release override requires CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA to equal the requested SHA'
  [[ ! -s "${STATE_FILE}" ]] \
    || fail 'initial release override is invalid because a prior image is recorded'
  [[ ! -e "${DATABASE_FILE}" ]] \
    || fail 'initial release override is invalid because a production database exists'
  for stale_path in \
    "${STATE_DIR}/current-revision" \
    "${STATE_DIR}/last-deployment.json" \
    "${STATE_DIR}/last-backup-verify.json" \
    "${STATE_DIR}/last-health.json" \
    "${STATE_DIR}/last-ops-status.json"; do
    [[ ! -e "${stale_path}" ]] \
      || fail "initial release override is invalid because stale runtime state exists: ${stale_path}"
  done
else
  [[ -s "${STATE_FILE}" ]] || fail 'standard deploy requires a recorded prior production image'
  PREVIOUS_IMAGE="$(<"${STATE_FILE}")"
  [[ "${PREVIOUS_IMAGE}" == chat-ailucy-v2:* ]] \
    || fail 'recorded prior image is outside the Chat V2 image namespace'
  command -v docker >/dev/null || fail 'docker is required to verify the prior image'
  docker image inspect "${PREVIOUS_IMAGE}" >/dev/null 2>&1 \
    || fail "recorded prior image is unavailable: ${PREVIOUS_IMAGE}"
  [[ -f "${DATABASE_FILE}" && -r "${DATABASE_FILE}" ]] \
    || fail 'standard deploy requires a readable production database for verified backup'
  DATABASE_PRESENT=true
fi

MODE="${MODE}" REVISION="${REVISION}" PREVIOUS_IMAGE="${PREVIOUS_IMAGE}" \
DATABASE_PRESENT="${DATABASE_PRESENT}" DEPLOY_ROOT_REAL="${DEPLOY_ROOT_REAL}" \
DATA_DIR_REAL="${DATA_DIR_REAL}" node - "${OUTPUT}" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
fs.writeFileSync(output, JSON.stringify({
  ok: true,
  mode: process.env.MODE,
  revision: process.env.REVISION,
  previousImage: process.env.PREVIOUS_IMAGE || null,
  databasePresent: process.env.DATABASE_PRESENT === 'true',
  deployRoot: process.env.DEPLOY_ROOT_REAL,
  dataDir: process.env.DATA_DIR_REAL,
  checkedAt: new Date().toISOString(),
}, null, 2) + '\n', { flag: 'wx' });
NODE

log "Rollback prerequisites passed in ${MODE} mode for ${REVISION}."
