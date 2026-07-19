#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${CHAT_REPO:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${GITHUB_ENVIRONMENT:-staging}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${CHAT_STAGING_BASE_URL:-http://127.0.0.1:14174}"

log() {
  printf '[chat-v2-browser-smoke] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in curl node npm npx python3; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

log 'Checking the deployed staging application.'
HEALTH="$(curl --fail --silent --show-error --max-time 15 "${BASE_URL%/}/api/health")"
python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") else 1)' <<<"${HEALTH}" \
  || fail 'staging health is not OK'

EMAIL="${CHAT_STAGING_EMAIL:-}"
if [[ -z "${EMAIL}" ]]; then
  command -v gh >/dev/null 2>&1 || fail 'missing command: gh'
  gh auth status >/dev/null
  EMAIL="$(
    gh api \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      "repos/${REPO}/environments/${ENVIRONMENT}/variables/CHAT_ALLOWED_EMAILS" \
      --jq '.value' 2>/dev/null || true
  )"
fi
EMAIL="$(printf '%s' "${EMAIL}" | cut -d',' -f1 | xargs)"
[[ -n "${EMAIL}" ]] || fail 'could not obtain the staging allowlisted email'

cd "${REPO_ROOT}"
if [[ ! -x node_modules/.bin/playwright ]]; then
  log 'Installing repository test dependencies locally.'
  npm install --no-audit --no-fund
fi

log 'Ensuring Chromium is available. The first installation may use roughly 200-300 MB in the user cache.'
npx playwright install chromium

log 'Running Chromium against the real localhost staging container.'
CHAT_STAGING_BASE_URL="${BASE_URL}" \
CHAT_STAGING_EMAIL="${EMAIL}" \
npm run test:e2e:staging

log 'PASS: real staging chat, links, uploads, downloads, persistence, drag-and-drop, and paste are healthy.'
