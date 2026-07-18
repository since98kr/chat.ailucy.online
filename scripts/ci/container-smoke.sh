#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${CHAT_CI_IMAGE:-chat-ailucy-v2:ci}"
PRIMARY_PORT="${CHAT_CI_PRIMARY_PORT:-4180}"
AUTH_PORT="${CHAT_CI_AUTH_PORT:-4181}"
PRIMARY_CONTAINER="chat-v2-ci"
AUTH_CONTAINER="chat-v2-auth"

log() { printf '[container-smoke] %s\n' "$*"; }

cleanup() {
  docker logs "${PRIMARY_CONTAINER}" || true
  docker logs "${AUTH_CONTAINER}" || true
  docker rm --force "${PRIMARY_CONTAINER}" "${AUTH_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm --force "${PRIMARY_CONTAINER}" "${AUTH_CONTAINER}" >/dev/null 2>&1 || true

log 'Starting primary runtime.'
docker run --detach --name "${PRIMARY_CONTAINER}" --publish "127.0.0.1:${PRIMARY_PORT}:4174" "${IMAGE}"
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${PRIMARY_PORT}/api/health" > health.json; then break; fi
  sleep 1
done
node -e "const h=require('./health.json');if(!h.ok||h.adapters.letta.mode!=='mock'||h.adapters.hermes.mode!=='mock')process.exit(1)"

log 'Checking web assets and security headers.'
curl --fail --silent --dump-header response-headers.txt "http://127.0.0.1:${PRIMARY_PORT}/" --output index.html
grep --quiet 'chat.ailucy.online V2' index.html
grep --ignore-case --quiet '^content-security-policy:' response-headers.txt
curl --fail --silent "http://127.0.0.1:${PRIMARY_PORT}/manifest.webmanifest" | grep --quiet 'Lucy Chat'
curl --fail --silent "http://127.0.0.1:${PRIMARY_PORT}/sw.js" | grep --quiet 'CACHE_NAME'
curl --fail --silent "http://127.0.0.1:${PRIMARY_PORT}/api/search?q=Chat&systemId=hermes" | grep --quiet 'Chat V2 개발'

log 'Creating an online backup inside the production image.'
docker exec "${PRIMARY_CONTAINER}" node dist-server/backup.js create | tee backup.json
BACKUP_ID="$(node -e "const j=require('./backup.json');if(!j.id)process.exit(1);process.stdout.write(j.id)")"
log "Verifying backup ${BACKUP_ID}."
docker exec "${PRIMARY_CONTAINER}" node dist-server/backup.js verify "/data/backups/${BACKUP_ID}" | tee backup-verify.json
node -e "const j=require('./backup-verify.json');if(!j.ok)process.exit(1)"
test "$(docker inspect --format='{{.State.Health.Status}}' "${PRIMARY_CONTAINER}")" != 'unhealthy'

log 'Starting token-authenticated runtime.'
docker run --detach --name "${AUTH_CONTAINER}" \
  --publish "127.0.0.1:${AUTH_PORT}:4174" \
  --env CHAT_AUTH_MODE=token \
  --env CHAT_ACCESS_TOKEN=ci-secret \
  "${IMAGE}"
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${AUTH_PORT}/api/health" >/dev/null; then break; fi
  sleep 1
done

UNAUTHORIZED_CODE="$(curl --silent --output unauthorized.json --write-out '%{http_code}' "http://127.0.0.1:${AUTH_PORT}/api/conversations")"
log "Unauthorized response: ${UNAUTHORIZED_CODE} $(cat unauthorized.json)"
test "${UNAUTHORIZED_CODE}" = '401'
curl --fail --silent --header 'Authorization: Bearer ci-secret' "http://127.0.0.1:${AUTH_PORT}/api/conversations" > authorized.json
node -e "const j=require('./authorized.json');if(!Array.isArray(j.conversations))process.exit(1)"
log 'Container security and recovery smoke passed.'
