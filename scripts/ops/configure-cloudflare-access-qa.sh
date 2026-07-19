#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${CHAT_REPO:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${GITHUB_ENVIRONMENT:-staging}"
DEFAULT_CLIENT_ID="${CF_ACCESS_CLIENT_ID_DEFAULT:-a12fba8e18fb4e9540782d70d3cf4fee.access}"
WORKFLOW="${CHAT_STAGING_DEPLOY_WORKFLOW:-deploy-staging.yml}"

log() {
  printf '[chat-v2-access-setup] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in gh git; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

gh auth status >/dev/null

CLIENT_ID="${CF_ACCESS_CLIENT_ID:-}"
if [[ -z "${CLIENT_ID}" ]]; then
  read -r -p "Cloudflare Access Client ID [${DEFAULT_CLIENT_ID}]: " CLIENT_ID
  CLIENT_ID="${CLIENT_ID:-${DEFAULT_CLIENT_ID}}"
fi
[[ "${CLIENT_ID}" =~ ^[A-Za-z0-9._-]+\.access$ ]] || fail 'Client ID must end with .access'

ISSUER="${CHAT_CF_ACCESS_ISSUER:-}"
if [[ -z "${ISSUER}" ]]; then
  printf '%s\n' 'Example team domain: https://your-team.cloudflareaccess.com'
  read -r -p 'Access team domain: ' ISSUER
fi
[[ "${ISSUER}" =~ ^https://[A-Za-z0-9.-]+\.cloudflareaccess\.com/?$ ]] \
  || fail 'team domain format is invalid'
ISSUER="${ISSUER%/}"

AUD="${CHAT_CF_ACCESS_AUD:-}"
if [[ -z "${AUD}" ]]; then
  read -r -p 'Application AUD tag: ' AUD
fi
[[ "${AUD}" =~ ^[A-Fa-f0-9]{64}$ ]] || fail 'AUD must be 64 hexadecimal characters'
AUD="${AUD,,}"

log 'Saving Cloudflare Access settings to the GitHub staging Environment.'
gh variable set CHAT_ALLOWED_SERVICE_CLIENT_IDS --repo "${REPO}" --env "${ENVIRONMENT}" --body "${CLIENT_ID}"
gh variable set CHAT_CF_ACCESS_ISSUER --repo "${REPO}" --env "${ENVIRONMENT}" --body "${ISSUER}"
gh variable set CHAT_CF_ACCESS_AUD --repo "${REPO}" --env "${ENVIRONMENT}" --body "${AUD}"
gh variable set CF_ACCESS_CLIENT_ID --repo "${REPO}" --env "${ENVIRONMENT}" --body "${CLIENT_ID}"
gh variable set CHAT_EXTERNAL_QA_REQUIRED --repo "${REPO}" --env "${ENVIRONMENT}" --body 'true'

log 'GitHub CLI will now request the Cloudflare Client Secret. It is not handled by this script.'
gh secret set CF_ACCESS_CLIENT_SECRET --repo "${REPO}" --env "${ENVIRONMENT}"

REVISION="$(gh api "repos/${REPO}/commits/main" --jq '.sha')"
log "Triggering staging deployment and external QA for ${REVISION}."
gh workflow run "${WORKFLOW}" --repo "${REPO}" --ref main -f "ref=${REVISION}"

RUN_ID=''
for _attempt in $(seq 1 30); do
  RUN_ID="$(
    gh run list \
      --repo "${REPO}" \
      --workflow "${WORKFLOW}" \
      --event workflow_dispatch \
      --limit 20 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"${REVISION}\") | .databaseId" |
    head -n 1
  )"
  [[ -n "${RUN_ID}" ]] && break
  sleep 1
done
[[ -n "${RUN_ID}" ]] || fail 'could not find the staging deployment run'

gh run watch "${RUN_ID}" --repo "${REPO}" --exit-status
log 'PASS: public Cloudflare staging QA is active.'
