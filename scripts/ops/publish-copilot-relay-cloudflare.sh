#!/usr/bin/env bash
set -Eeuo pipefail

HOSTNAME="${COPILOT_RELAY_HOSTNAME:-relay.ailucy.online}"
SERVICE_URL="${COPILOT_RELAY_SERVICE_URL:-http://127.0.0.1:14174}"
LOCAL_HEALTH_URL="${SERVICE_URL%/}/api/health"
CLOUDFLARED_UNIT="${CLOUDFLARED_SERVICE:-cloudflared.service}"
CONFIG_PATH="${CLOUDFLARED_CONFIG:-}"
BACKUP_PATH=""
CONFIG_CHANGED=0
RESTARTED=0
TMP_DIR="$(mktemp -d)"

log() { printf '[copilot-relay-cloudflare] %s\n' "$*"; }
fail() { log "ERROR: $*"; return 1; }
cleanup() { rm -rf "${TMP_DIR}"; }
rollback() {
  local status=$?
  trap - ERR
  if [[ "${CONFIG_CHANGED}" == '1' && -n "${BACKUP_PATH}" && -f "${BACKUP_PATH}" ]]; then
    log 'Publishing failed. Restoring previous cloudflared configuration.'
    sudo cp -a "${BACKUP_PATH}" "${CONFIG_PATH}"
    sudo systemctl restart "${CLOUDFLARED_UNIT}" || true
  elif [[ "${RESTARTED}" == '1' ]]; then
    log 'Publishing failed after cloudflared restart; configuration was unchanged by this run.'
  fi
  exit "${status}"
}
trap cleanup EXIT
trap rollback ERR

for command in curl python3 systemctl cloudflared; do
  command -v "${command}" >/dev/null || fail "Required command is missing: ${command}"
done
[[ "${HOSTNAME}" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'Invalid relay hostname.'
[[ "${SERVICE_URL}" == http://127.0.0.1:* ]] || fail 'Relay service must be the loopback staging service.'

log 'Checking staging runtime before publishing relay hostname.'
LOCAL_HEALTH="$(curl --fail --silent --show-error --max-time 10 "${LOCAL_HEALTH_URL}")"
python3 -c 'import json,sys; data=json.load(sys.stdin); raise SystemExit(0 if data.get("ok") else 1)' <<<"${LOCAL_HEALTH}" \
  || fail 'Local staging health is not OK.'

sudo -v
UNIT_TEXT="$(sudo systemctl cat "${CLOUDFLARED_UNIT}")"
if [[ -z "${CONFIG_PATH}" ]]; then
  CONFIG_PATH="$(python3 -c '
import re,sys
text=sys.stdin.read()
matches=re.findall(r"--config(?:=|\\s+)(?:\"([^\"]+)\"|\\x27([^\\x27]+)\\x27|(\\S+))", text)
if matches: print(next(value for value in reversed(matches[-1]) if value))
' <<<"${UNIT_TEXT}")"
fi
if [[ -z "${CONFIG_PATH}" ]]; then
  if grep -Eq -- '--token|TUNNEL_TOKEN' <<<"${UNIT_TEXT}"; then
    fail 'cloudflared is remotely managed; refusing to invent a local ingress change.'
  fi
  for candidate in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml "${HOME}/.cloudflared/config.yml" "${HOME}/.cloudflared/config.yaml"; do
    [[ -f "${candidate}" ]] && { CONFIG_PATH="${candidate}"; break; }
  done
fi
[[ -n "${CONFIG_PATH}" && -f "${CONFIG_PATH}" ]] || fail 'Could not find locally managed cloudflared config.'

TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
BACKUP_PATH="${CONFIG_PATH}.copilot-relay-backup.${TIMESTAMP}"
sudo cp -a "${CONFIG_PATH}" "${BACKUP_PATH}"
log "Configuration backup created: ${BACKUP_PATH}"

EDIT_RESULT="$(sudo python3 - "${CONFIG_PATH}" "${HOSTNAME}" "${SERVICE_URL}" <<'PY'
import os,re,sys
path,hostname,service=sys.argv[1:]
lines=open(path,encoding='utf-8').readlines()
host_re=re.compile(r'^\s*-?\s*hostname:\s*["\x27]?([^"\x27#\s]+)')
for i,line in enumerate(lines):
    m=host_re.match(line)
    if not m or m.group(1)!=hostname: continue
    block=''.join(lines[i:i+6])
    s=re.search(r'^\s*service:\s*["\x27]?([^"\x27#\s]+)',block,re.MULTILINE)
    if s and s.group(1)==service:
        print('unchanged'); raise SystemExit(0)
    raise SystemExit(f'Existing hostname {hostname} points elsewhere; refusing overwrite.')
ingress=next((i for i,line in enumerate(lines) if re.match(r'^\s*ingress:\s*(?:#.*)?$',line)),None)
if ingress is None: raise SystemExit('ingress section not found')
catch=None; indent=None
for i in range(ingress+1,len(lines)):
    m=re.match(r'^(\s*)-\s*service:\s*["\x27]?http_status:',lines[i])
    if m: catch=i; indent=m.group(1); break
if catch is None: raise SystemExit('final http_status catch-all not found')
lines[catch:catch]=[f'{indent}- hostname: {hostname}\n',f'{indent}  service: {service}\n']
st=os.stat(path); tmp=f'{path}.copilot-relay-tmp-{os.getpid()}'
with open(tmp,'w',encoding='utf-8') as h: h.writelines(lines)
os.chmod(tmp,st.st_mode); os.chown(tmp,st.st_uid,st.st_gid); os.replace(tmp,path)
print('changed')
PY
)"
if [[ "${EDIT_RESULT}" == 'changed' ]]; then CONFIG_CHANGED=1; log "Added ${HOSTNAME} -> ${SERVICE_URL}."; else log 'Relay ingress already present.'; fi

sudo cloudflared tunnel --config "${CONFIG_PATH}" ingress validate >/dev/null
RULE_OUTPUT="$(sudo cloudflared tunnel --config "${CONFIG_PATH}" ingress rule "https://${HOSTNAME}")"
grep -Fq "${SERVICE_URL}" <<<"${RULE_OUTPUT}" || fail 'Relay hostname did not match staging service.'
TUNNEL_ID="$(sudo python3 - "${CONFIG_PATH}" <<'PY'
import re,sys
text=open(sys.argv[1],encoding='utf-8').read()
m=re.search(r'^\s*tunnel:\s*["\x27]?([^"\x27#\s]+)',text,re.MULTILINE)
if m: print(m.group(1))
PY
)"
[[ -n "${TUNNEL_ID}" ]] || fail 'Tunnel id not found.'

set +e
DNS_OUTPUT="$(sudo cloudflared tunnel route dns "${TUNNEL_ID}" "${HOSTNAME}" 2>&1)"
DNS_STATUS=$?
set -e
if [[ "${DNS_STATUS}" -ne 0 ]] && ! getent ahosts "${HOSTNAME}" >/dev/null 2>&1; then
  printf '%s\n' "${DNS_OUTPUT}" >&2
  fail 'Could not create or confirm relay DNS route.'
fi

log 'Restarting cloudflared after validated non-destructive ingress change.'
sudo systemctl restart "${CLOUDFLARED_UNIT}"
RESTARTED=1
sudo systemctl is-active --quiet "${CLOUDFLARED_UNIT}" || fail 'cloudflared did not return active.'

log 'Verifying public relay reaches MCP authentication boundary without Cloudflare Access redirect.'
HEADERS="${TMP_DIR}/headers"; BODY="${TMP_DIR}/body"; STATUS='000'
for _attempt in $(seq 1 30); do
  : >"${HEADERS}"; : >"${BODY}"
  STATUS="$(curl --silent --show-error --connect-timeout 5 --max-time 12 --dump-header "${HEADERS}" --output "${BODY}" --write-out '%{http_code}' "https://${HOSTNAME}/mcp/copilot-relay" 2>/dev/null || printf '000')"
  [[ "${STATUS}" != '000' ]] && break
  sleep 2
done
if [[ "${STATUS}" == '302' || "${STATUS}" == '301' || "${STATUS}" == '303' || "${STATUS}" == '307' || "${STATUS}" == '308' ]]; then
  LOCATION="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]+:[[:space:]]*/,""); sub(/\r$/,""); print; exit}' "${HEADERS}")"
  [[ "${LOCATION}" != *'cloudflareaccess.com'* && "${LOCATION}" != *'/cdn-cgi/access/login'* ]] || fail 'Cloudflare Access intercepts relay hostname; Copilot API-key MCP would be unreachable.'
fi
[[ "${STATUS}" == '401' ]] || { cat "${BODY}" >&2 || true; fail "Expected MCP authentication boundary HTTP 401, got ${STATUS}."; }
grep -Fq 'MCP_AUTHENTICATION_REQUIRED' "${BODY}" || fail 'Public relay response was not the expected MCP auth boundary.'

trap - ERR
log "PASS: https://${HOSTNAME}/mcp/copilot-relay reaches staging MCP and is protected by its own API-key boundary."
