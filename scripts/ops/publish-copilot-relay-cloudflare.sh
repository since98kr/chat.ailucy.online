#!/usr/bin/env bash
set -Eeuo pipefail

HOSTNAME="${COPILOT_RELAY_HOSTNAME:-relay.ailucy.online}"
SERVICE_URL="${COPILOT_RELAY_SERVICE_URL:-http://127.0.0.1:14175}"
TUNNEL_NAME="${COPILOT_RELAY_TUNNEL_NAME:-copilot-relay-ailucy-online}"
CONTAINER_NAME="${COPILOT_RELAY_CONTAINER_NAME:-copilot-relay-cloudflared}"
CLOUDFLARED_HOME="${CLOUDFLARED_HOME:-${HOME}/.cloudflared}"
CONFIG_PATH="${COPILOT_RELAY_CONFIG:-${CLOUDFLARED_HOME}/copilot-relay-config.yml}"
IMAGE="${CLOUDFLARED_IMAGE:-cloudflare/cloudflared:latest}"
TMP_DIR="$(mktemp -d)"

log() { printf '[copilot-relay-cloudflare] %s\n' "$*"; }
fail() { log "BLOCKED: $*"; exit 1; }
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

for command in cloudflared curl docker getent python3; do
  command -v "${command}" >/dev/null || fail "Required command is missing: ${command}"
done
[[ "${HOSTNAME}" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'Invalid relay hostname.'
[[ "${SERVICE_URL}" == 'http://127.0.0.1:14175' ]] || fail 'Relay service must be the bounded loopback proxy on 127.0.0.1:14175.'
docker info >/dev/null 2>&1 || fail 'Docker is unavailable to the staging runner.'

probe() {
  local url="$1" prefix="$2" status
  : >"${TMP_DIR}/${prefix}.headers"
  : >"${TMP_DIR}/${prefix}.body"
  status="$(curl --silent --show-error --connect-timeout 5 --max-time 12 \
    --dump-header "${TMP_DIR}/${prefix}.headers" \
    --output "${TMP_DIR}/${prefix}.body" \
    --write-out '%{http_code}' "${url}" 2>/dev/null || printf '000')"
  printf '%s' "${status}"
}

log 'Verifying the bounded local MCP proxy before Cloudflare changes.'
LOCAL_STATUS="$(probe "${SERVICE_URL%/}/mcp/copilot-relay" local)"
[[ "${LOCAL_STATUS}" == '401' ]] || fail "Expected local HTTP 401, got ${LOCAL_STATUS}."
grep -Fq 'MCP_AUTHENTICATION_REQUIRED' "${TMP_DIR}/local.body" \
  || fail 'Local proxy did not return MCP_AUTHENTICATION_REQUIRED.'

PUBLIC_STATUS="$(probe "https://${HOSTNAME}/mcp/copilot-relay" public)"
if [[ "${PUBLIC_STATUS}" == '401' ]] && grep -Fq 'MCP_AUTHENTICATION_REQUIRED' "${TMP_DIR}/public.body"; then
  log "PASS: dedicated https://${HOSTNAME}/mcp/copilot-relay already reaches the application authentication boundary."
  exit 0
fi

if getent ahosts "${HOSTNAME}" >/dev/null 2>&1; then
  fail "${HOSTNAME} already resolves but does not return the required application 401; refusing to overwrite existing DNS or route state."
fi

mkdir -p "${CLOUDFLARED_HOME}"
TUNNELS_JSON="${TMP_DIR}/tunnels.json"
cloudflared tunnel list --output json >"${TUNNELS_JSON}"
TUNNEL_ID="$(python3 - "${TUNNELS_JSON}" "${TUNNEL_NAME}" <<'PY'
import json,sys
items=json.load(open(sys.argv[1],encoding='utf-8'))
matches=[str(item.get('id') or item.get('uuid') or '') for item in items if item.get('name')==sys.argv[2] and not item.get('deleted_at')]
if len(matches)>1: raise SystemExit('duplicate dedicated tunnel names')
print(matches[0] if matches else '')
PY
)" || fail 'Could not resolve dedicated tunnel state.'

if [[ -z "${TUNNEL_ID}" ]]; then
  log "Creating dedicated named Tunnel ${TUNNEL_NAME}."
  CREATE_OUTPUT="$(cloudflared tunnel create "${TUNNEL_NAME}")"
  cloudflared tunnel list --output json >"${TUNNELS_JSON}"
  TUNNEL_ID="$(python3 - "${TUNNELS_JSON}" "${TUNNEL_NAME}" <<'PY'
import json,sys
items=json.load(open(sys.argv[1],encoding='utf-8'))
matches=[str(item.get('id') or item.get('uuid') or '') for item in items if item.get('name')==sys.argv[2] and not item.get('deleted_at')]
if len(matches)!=1: raise SystemExit('dedicated tunnel was not uniquely created')
print(matches[0])
PY
)" || fail 'Dedicated tunnel creation could not be confirmed.'
else
  log "Reusing independently named relay Tunnel ${TUNNEL_NAME}."
fi

CREDS_PATH="${CLOUDFLARED_HOME}/${TUNNEL_ID}.json"
[[ -r "${CREDS_PATH}" ]] || fail 'Dedicated tunnel exists but its credentials are unavailable; refusing unrelated tunnel reuse.'

umask 077
CONFIG_TMP="${TMP_DIR}/config.yml"
printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/credentials.json\ningress:\n  - hostname: %s\n    service: %s\n  - service: http_status:404\n' \
  "${TUNNEL_ID}" "${HOSTNAME}" "${SERVICE_URL}" >"${CONFIG_TMP}"
cloudflared tunnel --config "${CONFIG_TMP}" ingress validate >/dev/null
install -m 600 "${CONFIG_TMP}" "${CONFIG_PATH}"

if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  EXISTING_ROLE="$(docker inspect --format '{{ index .Config.Labels "online.ailucy.role" }}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  EXISTING_TUNNEL="$(docker inspect --format '{{ index .Config.Labels "online.ailucy.tunnel" }}' "${CONTAINER_NAME}" 2>/dev/null || true)"
  [[ "${EXISTING_ROLE}" == 'copilot-relay' && "${EXISTING_TUNNEL}" == "${TUNNEL_ID}" ]] \
    || fail "Container name ${CONTAINER_NAME} is owned by another service; refusing replacement."
  log 'Restarting the independently owned relay connector.'
  docker restart "${CONTAINER_NAME}" >/dev/null
else
  log 'Starting the dedicated relay connector without changing existing cloudflared services.'
  docker run --detach \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    --user "$(id -u):$(id -g)" \
    --label online.ailucy.role=copilot-relay \
    --label "online.ailucy.tunnel=${TUNNEL_ID}" \
    --volume "${CONFIG_PATH}:/etc/cloudflared/config.yml:ro" \
    --volume "${CREDS_PATH}:/etc/cloudflared/credentials.json:ro" \
    "${IMAGE}" tunnel --no-autoupdate --config /etc/cloudflared/config.yml run >/dev/null
fi

for _attempt in $(seq 1 20); do
  docker container inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -Fxq true && break
  sleep 1
done
docker container inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -Fxq true \
  || fail 'Dedicated relay connector did not remain running.'

log 'Creating the relay DNS route without overwrite permission.'
DNS_OUTPUT="$(cloudflared tunnel route dns "${TUNNEL_ID}" "${HOSTNAME}" 2>&1)" \
  || fail "DNS route creation failed; existing records were not overwritten. ${DNS_OUTPUT}"

STATUS='000'
for _attempt in $(seq 1 30); do
  STATUS="$(probe "https://${HOSTNAME}/mcp/copilot-relay" final)"
  if [[ "${STATUS}" == '401' ]] && grep -Fq 'MCP_AUTHENTICATION_REQUIRED' "${TMP_DIR}/final.body"; then
    break
  fi
  sleep 2
done

if [[ "${STATUS}" =~ ^30[12378]$ ]]; then
  LOCATION="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]+:[[:space:]]*/,""); sub(/\r$/,""); print; exit}' "${TMP_DIR}/final.headers")"
  [[ "${LOCATION}" != *'cloudflareaccess.com'* && "${LOCATION}" != *'/cdn-cgi/access/login'* ]] \
    || fail 'Cloudflare Access intercepts the MCP API-key endpoint.'
fi
[[ "${STATUS}" == '401' ]] || fail "Expected public HTTP 401, got ${STATUS}."
grep -Fq 'MCP_AUTHENTICATION_REQUIRED' "${TMP_DIR}/final.body" \
  || fail 'Public response did not contain MCP_AUTHENTICATION_REQUIRED.'

log "PASS: dedicated https://${HOSTNAME}/mcp/copilot-relay returned HTTP 401 with MCP_AUTHENTICATION_REQUIRED; unrelated Cloudflare state changed=false."
