#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTROL_SCRIPT="${REPO_ROOT}/scripts/ops/production-control-plane.sh"
CANDIDATE_SHA='9a787035ec65e6e9973222b99cb427c64d108f4b'
TMP_DIR="$(mktemp -d)"
FAKE_BIN="${TMP_DIR}/bin"
GH_LOG="${TMP_DIR}/gh.log"
VARIABLE_FILE="${TMP_DIR}/production.env"
trap 'rm -rf "${TMP_DIR}"' EXIT
mkdir -p "${FAKE_BIN}"

cat >"${FAKE_BIN}/gh" <<'GH'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"${GH_FAKE_LOG}"
printf '\n' >>"${GH_FAKE_LOG}"

if [[ "${1:-}" == 'auth' && "${2:-}" == 'status' ]]; then
  exit 0
fi

if [[ "${1:-}" == 'api' ]]; then
  endpoint=''
  for arg in "$@"; do
    if [[ "${arg}" == repos/* ]]; then
      endpoint="${arg}"
      break
    fi
  done
  case "${endpoint}" in
    repos/since98kr/chat.ailucy.online/compare/*...main)
      printf '%s\n' '{"status":"ahead"}'
      ;;
    repos/since98kr/chat.ailucy.online/environments/production/variables/CHAT_PRODUCTION_APPROVED_SHA)
      printf '%s\n' '{"name":"CHAT_PRODUCTION_APPROVED_SHA","value":"9a787035ec65e6e9973222b99cb427c64d108f4b"}'
      ;;
    repos/since98kr/chat.ailucy.online/environments/production/variables/CHAT_PRODUCTION_RELEASE_ENABLED)
      printf '%s\n' '{"name":"CHAT_PRODUCTION_RELEASE_ENABLED","value":"false"}'
      ;;
    repos/since98kr/chat.ailucy.online/environments/production)
      printf '%s\n' '{"name":"production","protection_rules":[{"type":"required_reviewers","reviewers":[{"type":"User","reviewer":{"id":123}}]}]}'
      ;;
    repos/since98kr/chat.ailucy.online/actions/runners)
      printf '%s\n' '{"total_count":1,"runners":[{"name":"agentlucy-chat-production","status":"online","busy":false,"labels":[{"name":"self-hosted"},{"name":"linux"},{"name":"x64"},{"name":"chat-production"}]}]}'
      ;;
    *)
      printf 'unexpected fake gh api endpoint: %s\n' "${endpoint}" >&2
      exit 90
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == 'workflow' && "${2:-}" == 'view' ]]; then
  printf '%s\n' 'name: Production release gate'
  exit 0
fi

if [[ "${1:-}" == 'workflow' && "${2:-}" == 'run' ]]; then
  exit 0
fi

if [[ "${1:-}" == 'run' && "${2:-}" == 'list' ]]; then
  printf '%s\n' '{"databaseId":12345,"status":"queued","url":"https://example.invalid/run/12345","headSha":"9a787035ec65e6e9973222b99cb427c64d108f4b"}'
  exit 0
fi

printf 'unexpected fake gh command: %q ' "$@" >&2
printf '\n' >&2
exit 91
GH
chmod +x "${FAKE_BIN}/gh"

cat >"${VARIABLE_FILE}" <<'ENV'
CHAT_PRODUCTION_PORT=15174
CHAT_PUBLIC_ORIGIN=https://chat.example.invalid
CHAT_ALLOWED_ORIGIN=https://chat.example.invalid
CHAT_AUTH_MODE=cloudflare
CHAT_ALLOWED_EMAILS=operator@example.invalid
CHAT_CF_ACCESS_ISSUER=https://example.cloudflareaccess.com
CHAT_CF_ACCESS_AUD=example-audience
CHAT_PREFLIGHT_MIN_FREE_BYTES=2147483648
CHAT_BACKUP_RETENTION=10
LETTA_BASE_URL=http://letta.example.invalid
LETTA_AGENT_ID=letta-production
HERMES_BASE_URL=http://hermes.example.invalid
HERMES_AGENT_ID=hermes-production
CF_ACCESS_CLIENT_ID=production-client-id
ENV

export PATH="${FAKE_BIN}:${PATH}"
export GH_FAKE_LOG="${GH_LOG}"

run_control() {
  GITHUB_REPOSITORY='since98kr/chat.ailucy.online' \
  CHAT_PRODUCTION_CANDIDATE_SHA="${CANDIDATE_SHA}" \
  bash "${CONTROL_SCRIPT}" "$@"
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${TMP_DIR}/${label}.out" 2>"${TMP_DIR}/${label}.err"; then
    printf 'expected failure but command passed: %s\n' "${label}" >&2
    exit 1
  fi
}

run_control inspect >"${TMP_DIR}/inspect.log"
grep -Fq 'Production control plane is ready for preflight.' "${TMP_DIR}/inspect.log"
grep -Fq 'Release switch: false' "${TMP_DIR}/inspect.log"
grep -Fq 'no chat-staging label' "${TMP_DIR}/inspect.log"

CF_ACCESS_CLIENT_SECRET='do-not-print-this-secret' \
PRODUCTION_SECRET_NAMES='CF_ACCESS_CLIENT_SECRET' \
PRODUCTION_VARIABLE_FILE="${VARIABLE_FILE}" \
run_control configure >"${TMP_DIR}/configure.log"
grep -Fq 'DRY RUN: production Environment would be configured' "${TMP_DIR}/configure.log"
grep -Fq 'CF_ACCESS_CLIENT_SECRET' "${TMP_DIR}/configure.log"
if grep -Fq 'do-not-print-this-secret' "${TMP_DIR}/configure.log"; then
  echo 'dry-run output exposed a secret value' >&2
  exit 1
fi

cp "${VARIABLE_FILE}" "${TMP_DIR}/staging-port.env"
sed -i 's/CHAT_PRODUCTION_PORT=15174/CHAT_PRODUCTION_PORT=14174/' "${TMP_DIR}/staging-port.env"
expect_failure staging-port env PRODUCTION_VARIABLE_FILE="${TMP_DIR}/staging-port.env" \
  bash "${CONTROL_SCRIPT}" configure

echo 'HERMES_API_KEY=must-not-be-a-variable' >>"${TMP_DIR}/secret-variable.env"
cat "${VARIABLE_FILE}" >>"${TMP_DIR}/secret-variable.env"
expect_failure secret-variable env PRODUCTION_VARIABLE_FILE="${TMP_DIR}/secret-variable.env" \
  bash "${CONTROL_SCRIPT}" configure

: >"${GH_LOG}"
run_control dispatch-preflight >"${TMP_DIR}/dispatch-dry.log"
grep -Fq 'DRY RUN: production preflight is ready but was not dispatched.' "${TMP_DIR}/dispatch-dry.log"
if grep -Fq 'workflow run' "${GH_LOG}"; then
  echo 'dry-run unexpectedly dispatched a workflow' >&2
  exit 1
fi

: >"${GH_LOG}"
PRODUCTION_CONTROL_APPLY=true run_control dispatch-preflight >"${TMP_DIR}/dispatch-apply.log"
grep -Fq 'Production preflight workflow dispatched. Deploy mode was not requested.' "${TMP_DIR}/dispatch-apply.log"
grep -Fq 'workflow run production-release.yml' "${GH_LOG}"
grep -Fq 'revision=9a787035ec65e6e9973222b99cb427c64d108f4b' "${GH_LOG}"
grep -Fq 'mode=preflight' "${GH_LOG}"
if grep -Fq 'mode=deploy' "${GH_LOG}"; then
  echo 'preflight helper requested deploy mode' >&2
  exit 1
fi

printf '%s\n' '[production-control-plane-smoke] PASS'
