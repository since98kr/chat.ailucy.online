#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${GITHUB_REPOSITORY:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${GITHUB_ENVIRONMENT:-staging}"
REMOTE_HOST="${LETTA_SSH_HOST:-ax.hni-gl.ai}"
REMOTE_PORT="${LETTA_SSH_PORT:-3004}"
REMOTE_USER="${LETTA_SSH_USER:-since98kr}"

command -v gh >/dev/null || { echo 'GitHub CLI (gh) is required.' >&2; exit 1; }
gh auth status >/dev/null

CHAT_ALLOWED_EMAILS="${CHAT_ALLOWED_EMAILS:-}"
if [[ -z "${CHAT_ALLOWED_EMAILS}" ]]; then
  read -r -p 'Cloudflare Access login email: ' CHAT_ALLOWED_EMAILS
fi
[[ -n "${CHAT_ALLOWED_EMAILS}" ]] || { echo 'CHAT_ALLOWED_EMAILS is required.' >&2; exit 1; }

printf 'Ensuring GitHub Environment %s exists...\n' "${ENVIRONMENT}"
gh api --method PUT "repos/${REPO}/environments/${ENVIRONMENT}" --silent

set_variable() {
  local name="$1"
  local value="$2"
  printf 'Setting %-32s\n' "${name}"
  gh variable set "${name}" --body "${value}" --repo "${REPO}" --env "${ENVIRONMENT}"
}

set_variable CHAT_PUBLIC_ORIGIN 'https://chat-staging.ailucy.online'
set_variable CHAT_ALLOWED_ORIGIN 'https://chat-staging.ailucy.online'
set_variable CHAT_AUTH_MODE 'cloudflare'
set_variable CHAT_ALLOWED_EMAILS "${CHAT_ALLOWED_EMAILS}"
set_variable CHAT_BACKUP_RETENTION '10'
set_variable CHAT_PREFLIGHT_MIN_FREE_BYTES '2147483648'
set_variable CHAT_RATE_LIMIT_GENERAL '300'
set_variable CHAT_RATE_LIMIT_CHAT '30'
set_variable CHAT_RATE_LIMIT_UPLOAD '60'

set_variable LETTA_BASE_URL 'http://host.docker.internal:18283'
set_variable LETTA_CHAT_PATH '/v1/chat/stream'
set_variable LETTA_HEALTH_PATH '/health'
set_variable LETTA_AGENT_ID 'agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c'
set_variable LETTA_TIMEOUT_MS '300000'
set_variable LETTA_PROTOCOL 'native'
set_variable LETTA_MODEL_MAP_JSON '{}'

set_variable HERMES_BASE_URL 'http://hermes:8643'
set_variable HERMES_CHAT_PATH '/v1/chat/completions'
set_variable HERMES_HEALTH_PATH '/health'
set_variable HERMES_AGENT_ID '[Hermes] Lucy'
set_variable HERMES_TIMEOUT_MS '120000'
set_variable HERMES_PROTOCOL 'openai'
set_variable HERMES_MODEL_MAP_JSON '{}'
set_variable HERMES_DOCKER_NETWORK 'hermes_default'

printf 'Reading the Letta bridge token over SSH without printing it...\n'
TOKEN="$({
  ssh -p "${REMOTE_PORT}" \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    "${REMOTE_USER}@${REMOTE_HOST}" \
    "sed -n 's/^LETTA_BRIDGE_TOKEN=//p' ~/.config/letta-bridge.env"
} | head -n 1)"
[[ -n "${TOKEN}" ]] || {
  echo 'Could not read LETTA_BRIDGE_TOKEN. Install the bridge and passwordless SSH first.' >&2
  exit 1
}
printf '%s' "${TOKEN}" | gh secret set LETTA_API_KEY --repo "${REPO}" --env "${ENVIRONMENT}"
unset TOKEN

printf '\nConfigured GitHub Environment variables:\n'
gh variable list --repo "${REPO}" --env "${ENVIRONMENT}"
printf '\nLETTA_API_KEY was stored as an Environment secret. Its value was not printed.\n'
