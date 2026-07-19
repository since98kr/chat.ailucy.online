#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${CHAT_STAGING_BASE_URL:-https://chat-staging.ailucy.online}"

log() {
  printf '[chat-v2-external-smoke] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in curl node npm npx; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

[[ -n "${CF_ACCESS_CLIENT_ID:-}" ]] || fail 'CF_ACCESS_CLIENT_ID is required'
[[ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]] || fail 'CF_ACCESS_CLIENT_SECRET is required'

log 'Checking Cloudflare Access service authentication.'
HTTP_STATUS="$(
  curl --silent --show-error --max-time 30 \
    --output /tmp/chat-v2-external-auth.json \
    --write-out '%{http_code}' \
    --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    "${BASE_URL%/}/api/auth/config"
)"
if [[ "${HTTP_STATUS}" != '200' ]]; then
  log "External Access preflight returned HTTP ${HTTP_STATUS}."
  cat /tmp/chat-v2-external-auth.json >&2 2>/dev/null || true
  fail 'Cloudflare Service Auth policy or service credentials are not ready'
fi

cd "${REPO_ROOT}"
if [[ ! -x node_modules/.bin/playwright ]]; then
  log 'Installing repository test dependencies locally.'
  npm install --no-audit --no-fund
fi

log 'Ensuring Chromium is available.'
npx playwright install chromium

log "Running Chromium through ${BASE_URL}."
CHAT_STAGING_BASE_URL="${BASE_URL}" \
CF_ACCESS_CLIENT_ID="${CF_ACCESS_CLIENT_ID}" \
CF_ACCESS_CLIENT_SECRET="${CF_ACCESS_CLIENT_SECRET}" \
npm run test:e2e:external

log 'PASS: Cloudflare Access, Tunnel, Chat V2, links, uploads, downloads, and persistence are healthy.'
