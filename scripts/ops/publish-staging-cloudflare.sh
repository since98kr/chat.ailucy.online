#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${GITHUB_REPOSITORY:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${GITHUB_ENVIRONMENT:-staging}"
HOSTNAME="${CHAT_STAGING_HOSTNAME:-chat-staging.ailucy.online}"
SERVICE_URL="${CHAT_STAGING_SERVICE_URL:-http://127.0.0.1:14174}"
LOCAL_HEALTH_URL="${SERVICE_URL%/}/api/health"
CLOUDFLARED_UNIT="${CLOUDFLARED_SERVICE:-cloudflared.service}"
CONFIG_PATH="${CLOUDFLARED_CONFIG:-}"
BACKUP_PATH=""
CONFIG_CHANGED=0
RESTARTED=0
TMP_DIR="$(mktemp -d)"

log() {
  printf '[chat-v2-cloudflare] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  return 1
}

cleanup() {
  rm -rf "${TMP_DIR}"
}

rollback() {
  local status=$?
  trap - ERR
  if [[ "${CONFIG_CHANGED}" == '1' && -n "${BACKUP_PATH}" && -f "${BACKUP_PATH}" ]]; then
    log 'Publishing failed. Restoring the previous cloudflared configuration.'
    sudo cp -a "${BACKUP_PATH}" "${CONFIG_PATH}"
    sudo systemctl restart "${CLOUDFLARED_UNIT}" || true
  elif [[ "${RESTARTED}" == '1' ]]; then
    log 'Publishing failed after cloudflared restart; configuration was not changed by this script.'
  fi
  exit "${status}"
}

trap cleanup EXIT
trap rollback ERR

for command in curl python3 systemctl cloudflared; do
  command -v "${command}" >/dev/null || fail "Required command is missing: ${command}"
done

log 'Checking the local staging application.'
LOCAL_HEALTH="$(curl --fail --silent --show-error --max-time 10 "${LOCAL_HEALTH_URL}")"
python3 -c 'import json,sys; data=json.load(sys.stdin); raise SystemExit(0 if data.get("ok") else 1)' <<<"${LOCAL_HEALTH}" \
  || fail 'Local staging health is not OK.'

PROBE_EMAIL="${CHAT_STAGING_PROBE_EMAIL:-}"
if [[ -z "${PROBE_EMAIL}" ]] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  PROBE_EMAIL="$(
    gh api \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "repos/${REPO}/environments/${ENVIRONMENT}/variables/CHAT_ALLOWED_EMAILS" \
      --jq '.value' 2>/dev/null | cut -d',' -f1 || true
  )"
fi
[[ -n "${PROBE_EMAIL}" ]] || fail 'Could not obtain the staging allowlisted email needed for the anti-spoof security probe.'

sudo -v
UNIT_TEXT="$(sudo systemctl cat "${CLOUDFLARED_UNIT}")"

if [[ -z "${CONFIG_PATH}" ]]; then
  CONFIG_PATH="$(
    python3 -c '
import re, sys
text = sys.stdin.read()
matches = re.findall(r"--config(?:=|\s+)(?:\"([^\"]+)\"|\x27([^\x27]+)\x27|(\S+))", text)
if matches:
    print(next(value for value in reversed(matches[-1]) if value))
' <<<"${UNIT_TEXT}"
  )"
fi

if [[ -z "${CONFIG_PATH}" ]]; then
  if grep -Eq -- '--token|TUNNEL_TOKEN' <<<"${UNIT_TEXT}"; then
    cat >&2 <<EOF
[chat-v2-cloudflare] This cloudflared service is remotely managed with a tunnel token.
[chat-v2-cloudflare] Local ingress editing is intentionally disabled.
[chat-v2-cloudflare] In Cloudflare Dashboard add a Published application route:
[chat-v2-cloudflare]   Hostname: ${HOSTNAME}
[chat-v2-cloudflare]   Service:  ${SERVICE_URL}
[chat-v2-cloudflare] Create or confirm a Cloudflare Access self-hosted application for the same hostname first.
EOF
    exit 21
  fi

  for candidate in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml "${HOME}/.cloudflared/config.yml" "${HOME}/.cloudflared/config.yaml"; do
    if [[ -f "${candidate}" ]]; then
      CONFIG_PATH="${candidate}"
      break
    fi
  done
fi

[[ -n "${CONFIG_PATH}" && -f "${CONFIG_PATH}" ]] || fail 'Could not find the locally managed cloudflared configuration file.'
log "Using cloudflared configuration: ${CONFIG_PATH}"

TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
BACKUP_PATH="${CONFIG_PATH}.chat-v2-backup.${TIMESTAMP}"
sudo cp -a "${CONFIG_PATH}" "${BACKUP_PATH}"
log "Configuration backup created: ${BACKUP_PATH}"

EDIT_RESULT="$(sudo python3 - "${CONFIG_PATH}" "${HOSTNAME}" "${SERVICE_URL}" <<'PY'
import os
import re
import sys

path, hostname, service = sys.argv[1:]
with open(path, 'r', encoding='utf-8') as handle:
    lines = handle.readlines()

hostname_pattern = re.compile(r'^\s*-?\s*hostname:\s*["\x27]?([^"\x27#\s]+)')
for index, line in enumerate(lines):
    match = hostname_pattern.match(line)
    if not match or match.group(1) != hostname:
        continue
    block = ''.join(lines[index:index + 6])
    service_match = re.search(r'^\s*service:\s*["\x27]?([^"\x27#\s]+)', block, re.MULTILINE)
    if service_match and service_match.group(1) == service:
        print('unchanged')
        raise SystemExit(0)
    raise SystemExit(f'Existing hostname {hostname} points to a different service; refusing to overwrite it.')

ingress_index = next((i for i, line in enumerate(lines) if re.match(r'^\s*ingress:\s*(?:#.*)?$', line)), None)
if ingress_index is None:
    raise SystemExit('ingress section not found')

catchall_index = None
catchall_indent = None
for index in range(ingress_index + 1, len(lines)):
    match = re.match(r'^(\s*)-\s*service:\s*["\x27]?http_status:', lines[index])
    if match:
        catchall_index = index
        catchall_indent = match.group(1)
        break

if catchall_index is None or catchall_indent is None:
    raise SystemExit('final http_status catch-all ingress rule not found')

insertion = [
    f'{catchall_indent}- hostname: {hostname}\n',
    f'{catchall_indent}  service: {service}\n',
]
lines[catchall_index:catchall_index] = insertion

stat = os.stat(path)
temporary = f'{path}.chat-v2-tmp-{os.getpid()}'
with open(temporary, 'w', encoding='utf-8') as handle:
    handle.writelines(lines)
os.chmod(temporary, stat.st_mode)
os.chown(temporary, stat.st_uid, stat.st_gid)
os.replace(temporary, path)
print('changed')
PY
)"

if [[ "${EDIT_RESULT}" == 'changed' ]]; then
  CONFIG_CHANGED=1
  log "Added ${HOSTNAME} -> ${SERVICE_URL} before the catch-all rule."
else
  log 'The staging ingress rule already exists with the expected service.'
fi

log 'Validating and matching the cloudflared ingress rule.'
sudo cloudflared tunnel --config "${CONFIG_PATH}" ingress validate >/dev/null
RULE_OUTPUT="$(sudo cloudflared tunnel --config "${CONFIG_PATH}" ingress rule "https://${HOSTNAME}")"
grep -Fq "${SERVICE_URL}" <<<"${RULE_OUTPUT}" || fail 'The hostname did not match the expected local staging service.'

TUNNEL_ID="$(sudo python3 - "${CONFIG_PATH}" <<'PY'
import re
import sys
text = open(sys.argv[1], 'r', encoding='utf-8').read()
match = re.search(r'^\s*tunnel:\s*["\x27]?([^"\x27#\s]+)', text, re.MULTILINE)
if match:
    print(match.group(1))
PY
)"
[[ -n "${TUNNEL_ID}" ]] || fail 'The tunnel name or UUID was not found in the local configuration.'

log 'Creating or confirming the Cloudflare Tunnel DNS route.'
set +e
DNS_OUTPUT="$(sudo cloudflared tunnel route dns "${TUNNEL_ID}" "${HOSTNAME}" 2>&1)"
DNS_STATUS=$?
set -e
if [[ "${DNS_STATUS}" -ne 0 ]]; then
  if getent ahosts "${HOSTNAME}" >/dev/null 2>&1; then
    log 'DNS route command reported an existing record; the hostname already resolves, so validation will continue.'
  else
    printf '%s\n' "${DNS_OUTPUT}" >&2
    fail 'Could not create the DNS route and the hostname does not resolve.'
  fi
fi

log 'Restarting cloudflared with the validated configuration.'
sudo systemctl restart "${CLOUDFLARED_UNIT}"
RESTARTED=1
sudo systemctl is-active --quiet "${CLOUDFLARED_UNIT}" || fail 'cloudflared did not return to active state.'

log 'Waiting for the public hostname and verifying the Cloudflare Access login gate.'
HEADERS="${TMP_DIR}/headers.txt"
BODY="${TMP_DIR}/body.txt"
PUBLIC_STATUS='000'
for _attempt in $(seq 1 30); do
  : >"${HEADERS}"
  : >"${BODY}"
  PUBLIC_STATUS="$(
    curl --silent --show-error --insecure \
      --connect-timeout 5 \
      --max-time 12 \
      --dump-header "${HEADERS}" \
      --output "${BODY}" \
      --write-out '%{http_code}' \
      --header "Cf-Access-Authenticated-User-Email: ${PROBE_EMAIL}" \
      "https://${HOSTNAME}/api/health" 2>/dev/null || printf '000'
  )"
  [[ "${PUBLIC_STATUS}" != '000' ]] && break
  sleep 2
done

if [[ "${PUBLIC_STATUS}" =~ ^2 ]]; then
  fail 'Security gate failed: a forged Cloudflare Access email header reached the application without login.'
fi

LOCATION="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "${HEADERS}")"
if [[ ! "${PUBLIC_STATUS}" =~ ^30[12378]$ ]] || [[ "${LOCATION}" != *'cloudflareaccess.com'* && "${LOCATION}" != *'/cdn-cgi/access/login'* ]]; then
  log "Unexpected public response: HTTP ${PUBLIC_STATUS}${LOCATION:+, Location=${LOCATION}}"
  fail 'Cloudflare Access login redirect was not confirmed; the ingress route will be rolled back.'
fi

trap - ERR
log "PASS: ${HOSTNAME} is routed to staging and protected by a Cloudflare Access login redirect."
log "Open in a browser: https://${HOSTNAME}"
log 'The existing production chat hostname was not changed.'
