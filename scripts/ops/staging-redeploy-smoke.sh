#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${CHAT_REPO:-since98kr/chat.ailucy.online}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="${CHAT_STAGING_DEPLOY_WORKFLOW:-deploy-staging.yml}"

log() {
  printf '[chat-v2-redeploy] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in gh git; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

gh auth status >/dev/null

REVISION="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
BRANCH="$(git -C "${REPO_ROOT}" branch --show-current)"
[[ "${BRANCH}" == 'main' ]] || fail "repository must be on main; current branch: ${BRANCH:-detached}"
[[ -z "$(git -C "${REPO_ROOT}" status --short)" ]] || fail 'repository has uncommitted changes'

log "Triggering staging deployment and full QA for ${REVISION}."
gh workflow run "${WORKFLOW}" \
  --repo "${REPO}" \
  --ref main \
  -f "ref=${REVISION}"

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

[[ -n "${RUN_ID}" ]] || fail "could not find the deployment run for ${REVISION}"

log "Watching deployment and QA run ${RUN_ID}."
gh run watch "${RUN_ID}" --repo "${REPO}" --exit-status

log 'PASS: deployment, Hermes/Letta transport, and real Chromium artifact QA completed in the staging workflow.'
