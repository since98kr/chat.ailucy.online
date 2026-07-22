#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${CHAT_PRODUCTION_ENVIRONMENT:-production}"
WORKFLOW="${CHAT_PRODUCTION_WORKFLOW:-production-release.yml}"
RUNNER_NAME="${CHAT_PRODUCTION_RUNNER_NAME:-agentlucy-chat-production}"
RUNNER_LABEL="${CHAT_PRODUCTION_RUNNER_LABEL:-chat-production}"
CANDIDATE_SHA="${CHAT_PRODUCTION_CANDIDATE_SHA:-9a787035ec65e6e9973222b99cb427c64d108f4b}"
APPLY="${PRODUCTION_CONTROL_APPLY:-false}"
VARIABLE_FILE="${PRODUCTION_VARIABLE_FILE:-}"
SECRET_NAMES_CSV="${PRODUCTION_SECRET_NAMES:-}"
REVIEWER_TYPE="${PRODUCTION_REVIEWER_TYPE:-}"
REVIEWER_ID="${PRODUCTION_REVIEWER_ID:-}"
PREVENT_SELF_REVIEW="${PRODUCTION_PREVENT_SELF_REVIEW:-true}"
ACTION="${1:-inspect}"

log() {
  printf '[chat-production-control] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

validate_common() {
  [[ "${REPOSITORY}" == 'since98kr/chat.ailucy.online' ]] \
    || fail 'this controller is repository-bound to since98kr/chat.ailucy.online'
  [[ "${ENVIRONMENT}" == 'production' ]] \
    || fail 'CHAT_PRODUCTION_ENVIRONMENT must remain production'
  [[ "${WORKFLOW}" == 'production-release.yml' ]] \
    || fail 'CHAT_PRODUCTION_WORKFLOW must remain production-release.yml'
  [[ "${RUNNER_LABEL}" == 'chat-production' ]] \
    || fail 'CHAT_PRODUCTION_RUNNER_LABEL must remain chat-production'
  [[ "${RUNNER_NAME,,}" == *production* && "${RUNNER_NAME,,}" != *staging* ]] \
    || fail 'production runner name must contain production and must not contain staging'
  [[ "${CANDIDATE_SHA}" =~ ^[0-9a-f]{40}$ ]] \
    || fail 'CHAT_PRODUCTION_CANDIDATE_SHA must be a full lowercase 40-character SHA'
  [[ "${APPLY}" == 'true' || "${APPLY}" == 'false' ]] \
    || fail 'PRODUCTION_CONTROL_APPLY must be true or false'
  [[ "${PREVENT_SELF_REVIEW}" == 'true' || "${PREVENT_SELF_REVIEW}" == 'false' ]] \
    || fail 'PRODUCTION_PREVENT_SELF_REVIEW must be true or false'
}

require_gh_auth() {
  require_command gh
  require_command node
  gh auth status --hostname github.com >/dev/null 2>&1 \
    || fail 'GitHub CLI is not authenticated for github.com'
}

json_value() {
  local field="$1"
  node -e '
    const fs = require("node:fs");
    const field = process.argv[1];
    const value = JSON.parse(fs.readFileSync(0, "utf8"));
    const result = field.split(".").reduce((current, key) => current?.[key], value);
    if (result === undefined || result === null) process.exit(2);
    process.stdout.write(String(result));
  ' "${field}"
}

assert_candidate_on_main() {
  local compare_json status
  compare_json="$(gh api "repos/${REPOSITORY}/compare/${CANDIDATE_SHA}...main")" \
    || fail 'could not compare the approved candidate with main'
  status="$(printf '%s' "${compare_json}" | json_value status)" \
    || fail 'GitHub compare response did not include a status'
  [[ "${status}" == 'ahead' || "${status}" == 'identical' ]] \
    || fail "candidate SHA is not contained in main history (compare status: ${status})"
}

get_environment_variable() {
  local name="$1" response
  response="$(gh api "repos/${REPOSITORY}/environments/${ENVIRONMENT}/variables/${name}")" \
    || fail "required production Environment variable is missing: ${name}"
  printf '%s' "${response}" | json_value value
}

inspect_control_plane() {
  local environment_json runner_json approved_sha release_enabled

  require_gh_auth
  assert_candidate_on_main

  environment_json="$(gh api "repos/${REPOSITORY}/environments/${ENVIRONMENT}")" \
    || fail 'GitHub production Environment does not exist or is not accessible'
  printf '%s' "${environment_json}" | node -e '
    const fs = require("node:fs");
    const environment = JSON.parse(fs.readFileSync(0, "utf8"));
    const rule = (environment.protection_rules || []).find((entry) => entry.type === "required_reviewers");
    if (!rule || !Array.isArray(rule.reviewers) || rule.reviewers.length < 1) process.exit(1);
  ' || fail 'production Environment must have at least one required reviewer'

  approved_sha="$(get_environment_variable CHAT_PRODUCTION_APPROVED_SHA)"
  [[ "${approved_sha}" == "${CANDIDATE_SHA}" ]] \
    || fail "Environment-approved SHA does not equal the frozen candidate (${approved_sha:-missing})"

  release_enabled="$(get_environment_variable CHAT_PRODUCTION_RELEASE_ENABLED)"
  [[ "${release_enabled,,}" == 'false' ]] \
    || fail 'CHAT_PRODUCTION_RELEASE_ENABLED must remain false for preflight'

  runner_json="$(gh api "repos/${REPOSITORY}/actions/runners")" \
    || fail 'could not inspect repository self-hosted runners'
  printf '%s' "${runner_json}" | node -e '
    const fs = require("node:fs");
    const expectedName = process.argv[1];
    const expectedLabel = process.argv[2];
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const runner = (payload.runners || []).find((entry) => entry.name === expectedName);
    if (!runner) process.exit(10);
    const labels = new Set((runner.labels || []).map((entry) => String(entry.name).toLowerCase()));
    if (runner.status !== "online" || runner.busy !== false) process.exit(11);
    if (!labels.has(expectedLabel.toLowerCase())) process.exit(12);
    if (labels.has("chat-staging")) process.exit(13);
  ' "${RUNNER_NAME}" "${RUNNER_LABEL}" \
    || fail 'dedicated production runner is missing, offline, busy, mislabeled, or shares the staging label'

  gh workflow view "${WORKFLOW}" --repo "${REPOSITORY}" --yaml >/dev/null \
    || fail 'production release workflow is unavailable'

  log 'Production control plane is ready for preflight.'
  log "Repository: ${REPOSITORY}"
  log "Environment: ${ENVIRONMENT} (required reviewer configured)"
  log "Candidate SHA: ${CANDIDATE_SHA} (contained in main)"
  log 'Release switch: false'
  log "Runner: ${RUNNER_NAME} (online, idle, ${RUNNER_LABEL}, no chat-staging label)"
  log "Workflow: ${WORKFLOW}"
}

validate_variable_name() {
  local name="$1"
  [[ "${name}" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid Environment variable name: ${name}"
  case "${name}" in
    *SECRET*|*TOKEN*|*_API_KEY|GITHUB_RUNNER_TOKEN)
      fail "refusing to store secret-like key as an Environment variable: ${name}"
      ;;
  esac
}

declare -A VARIABLES=()

set_variable() {
  local name="$1" value="$2"
  validate_variable_name "${name}"
  [[ -n "${value}" ]] || fail "Environment variable must not be empty: ${name}"
  VARIABLES["${name}"]="${value}"
}

load_variable_file() {
  local line name value line_number=0
  [[ -n "${VARIABLE_FILE}" ]] || return
  [[ -r "${VARIABLE_FILE}" ]] || fail "PRODUCTION_VARIABLE_FILE is not readable: ${VARIABLE_FILE}"

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line_number=$((line_number + 1))
    [[ -z "${line//[[:space:]]/}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" == *=* ]] || fail "invalid variable-file entry at line ${line_number}"
    name="${line%%=*}"
    value="${line#*=}"
    name="${name//[[:space:]]/}"
    [[ -n "${name}" ]] || fail "missing variable name at line ${line_number}"
    set_variable "${name}" "${value}"
  done <"${VARIABLE_FILE}"
}

prepare_variables() {
  local required

  set_variable CHAT_PRODUCTION_RELEASE_ENABLED false
  set_variable CHAT_PRODUCTION_APPROVED_SHA "${CANDIDATE_SHA}"
  set_variable CHAT_PRODUCTION_ROOT "${CHAT_PRODUCTION_ROOT:-/opt/chat-v2/production}"
  set_variable CHAT_PRODUCTION_DATA_DIR "${CHAT_PRODUCTION_DATA_DIR:-/opt/chat-v2/production/data}"
  set_variable CHAT_PRODUCTION_CONTAINER_NAME "${CHAT_PRODUCTION_CONTAINER_NAME:-chat-v2-production}"
  set_variable CHAT_PRODUCTION_COMPOSE_PROJECT "${CHAT_PRODUCTION_COMPOSE_PROJECT:-chat-v2-production}"
  [[ -n "${CHAT_PRODUCTION_PORT:-}" ]] && set_variable CHAT_PRODUCTION_PORT "${CHAT_PRODUCTION_PORT}"

  load_variable_file

  [[ "${VARIABLES[CHAT_PRODUCTION_RELEASE_ENABLED]}" == 'false' ]] \
    || fail 'configuration must keep CHAT_PRODUCTION_RELEASE_ENABLED=false'
  [[ "${VARIABLES[CHAT_PRODUCTION_APPROVED_SHA]}" == "${CANDIDATE_SHA}" ]] \
    || fail 'variable file may not override the frozen approved SHA'
  [[ "${VARIABLES[CHAT_PRODUCTION_ROOT]}" == /opt/chat-v2/production* ]] \
    || fail 'CHAT_PRODUCTION_ROOT must use the production namespace'
  [[ "${VARIABLES[CHAT_PRODUCTION_DATA_DIR]}" == "${VARIABLES[CHAT_PRODUCTION_ROOT]}"/* ]] \
    || fail 'CHAT_PRODUCTION_DATA_DIR must be contained in CHAT_PRODUCTION_ROOT'
  [[ "${VARIABLES[CHAT_PRODUCTION_CONTAINER_NAME]}" == 'chat-v2-production' ]] \
    || fail 'production container name must remain chat-v2-production'
  [[ "${VARIABLES[CHAT_PRODUCTION_COMPOSE_PROJECT]}" == 'chat-v2-production' ]] \
    || fail 'production Compose project must remain chat-v2-production'
  [[ "${VARIABLES[CHAT_PRODUCTION_PORT]:-}" =~ ^[0-9]{2,5}$ ]] \
    || fail 'CHAT_PRODUCTION_PORT must be supplied as a numeric production-only port'
  [[ "${VARIABLES[CHAT_PRODUCTION_PORT]}" != '14174' ]] \
    || fail 'production may not reuse the staging port 14174'

  for required in \
    CHAT_PUBLIC_ORIGIN CHAT_ALLOWED_ORIGIN CHAT_AUTH_MODE CHAT_ALLOWED_EMAILS \
    CHAT_CF_ACCESS_ISSUER CHAT_CF_ACCESS_AUD CHAT_PREFLIGHT_MIN_FREE_BYTES CHAT_BACKUP_RETENTION \
    LETTA_BASE_URL LETTA_AGENT_ID HERMES_BASE_URL HERMES_AGENT_ID CF_ACCESS_CLIENT_ID; do
    [[ -n "${VARIABLES[${required}]:-}" ]] \
      || fail "required production variable is missing from PRODUCTION_VARIABLE_FILE: ${required}"
  done

  [[ "${VARIABLES[CHAT_AUTH_MODE]}" == 'cloudflare' || "${VARIABLES[CHAT_AUTH_MODE]}" == 'token' ]] \
    || fail 'CHAT_AUTH_MODE must be cloudflare or token'
  [[ "${VARIABLES[CHAT_PUBLIC_ORIGIN]}" == https://* ]] \
    || fail 'CHAT_PUBLIC_ORIGIN must use https'
  [[ "${VARIABLES[CHAT_ALLOWED_ORIGIN]}" == "${VARIABLES[CHAT_PUBLIC_ORIGIN]}" ]] \
    || fail 'CHAT_ALLOWED_ORIGIN must equal CHAT_PUBLIC_ORIGIN for production bootstrap'
}

parse_secret_names() {
  local item
  SECRET_NAMES=()
  IFS=',' read -r -a SECRET_NAMES <<<"${SECRET_NAMES_CSV}"
  for item in "${SECRET_NAMES[@]}"; do
    [[ -z "${item}" ]] && continue
    [[ "${item}" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid production secret name: ${item}"
    [[ -n "${!item-}" ]] || fail "secret value is not present in the process environment: ${item}"
  done
}

configure_environment() {
  local name temp_json

  prepare_variables
  parse_secret_names

  if [[ "${APPLY}" != 'true' ]]; then
    log 'DRY RUN: production Environment would be configured; no GitHub state was changed.'
    log "Environment: ${ENVIRONMENT}"
    log "Approved candidate: ${CANDIDATE_SHA}"
    log 'Release switch: false'
    log "Variable names: $(printf '%s\n' "${!VARIABLES[@]}" | sort | paste -sd, -)"
    if [[ -n "${SECRET_NAMES_CSV}" ]]; then
      log "Secret names: $(printf '%s\n' "${SECRET_NAMES[@]}" | sed '/^$/d' | sort | paste -sd, -)"
    else
      log 'Secret names: none supplied'
    fi
    log 'Set PRODUCTION_CONTROL_APPLY=true only from an authenticated administrator session.'
    return
  fi

  require_gh_auth
  assert_candidate_on_main
  [[ "${REVIEWER_TYPE}" == 'User' || "${REVIEWER_TYPE}" == 'Team' ]] \
    || fail 'PRODUCTION_REVIEWER_TYPE must be User or Team when applying'
  [[ "${REVIEWER_ID}" =~ ^[1-9][0-9]*$ ]] \
    || fail 'PRODUCTION_REVIEWER_ID must be the numeric GitHub user or team ID when applying'

  temp_json="$(mktemp)"
  trap 'rm -f "${temp_json}"' RETURN
  REVIEWER_TYPE="${REVIEWER_TYPE}" REVIEWER_ID="${REVIEWER_ID}" \
    PREVENT_SELF_REVIEW="${PREVENT_SELF_REVIEW}" node -e '
      const fs = require("node:fs");
      const output = {
        wait_timer: 0,
        prevent_self_review: process.env.PREVENT_SELF_REVIEW === "true",
        reviewers: [{ type: process.env.REVIEWER_TYPE, id: Number(process.env.REVIEWER_ID) }],
      };
      fs.writeFileSync(process.argv[1], JSON.stringify(output));
    ' "${temp_json}"

  gh api --method PUT "repos/${REPOSITORY}/environments/${ENVIRONMENT}" --input "${temp_json}" >/dev/null
  log 'Production Environment and required-reviewer rule configured.'

  while IFS= read -r name; do
    gh variable set "${name}" --repo "${REPOSITORY}" --env "${ENVIRONMENT}" \
      --body "${VARIABLES[${name}]}" >/dev/null
    log "Environment variable configured: ${name}"
  done < <(printf '%s\n' "${!VARIABLES[@]}" | sort)

  for name in "${SECRET_NAMES[@]}"; do
    [[ -z "${name}" ]] && continue
    printf '%s' "${!name}" | gh secret set "${name}" --repo "${REPOSITORY}" --env "${ENVIRONMENT}" >/dev/null
    log "Environment secret configured: ${name}"
  done

  log 'Production Environment configuration applied with release disabled.'
}

dispatch_preflight() {
  inspect_control_plane

  if [[ "${APPLY}" != 'true' ]]; then
    log 'DRY RUN: production preflight is ready but was not dispatched.'
    log "Dispatch: gh workflow run ${WORKFLOW} --repo ${REPOSITORY} --ref main -f revision=${CANDIDATE_SHA} -f mode=preflight"
    log 'Set PRODUCTION_CONTROL_APPLY=true to dispatch after reviewing the inspection output.'
    return
  fi

  gh workflow run "${WORKFLOW}" --repo "${REPOSITORY}" --ref main \
    -f "revision=${CANDIDATE_SHA}" -f 'mode=preflight'
  log 'Production preflight workflow dispatched. Deploy mode was not requested.'
  gh run list --repo "${REPOSITORY}" --workflow "${WORKFLOW}" --limit 1 \
    --json databaseId,status,url,headSha --jq '.[0]'
}

usage() {
  cat <<'EOF'
Usage: production-control-plane.sh <inspect|configure|dispatch-preflight>

inspect
  Read-only validation of the production Environment, frozen SHA, release switch,
  dedicated runner, main ancestry, and workflow availability.

configure
  Validates a production variable file and secret names. Defaults to dry-run.
  Set PRODUCTION_CONTROL_APPLY=true, reviewer metadata, and authenticated gh only
  when intentionally applying GitHub Environment changes.

dispatch-preflight
  Runs the full read-only inspection, then defaults to a dry-run dispatch preview.
  Set PRODUCTION_CONTROL_APPLY=true to dispatch preflight mode only.
EOF
}

validate_common
case "${ACTION}" in
  inspect)
    inspect_control_plane
    ;;
  configure)
    configure_environment
    ;;
  dispatch-preflight)
    dispatch_preflight
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    fail "unsupported action: ${ACTION}"
    ;;
esac
