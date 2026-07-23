#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Full Letta bridge staging deployment failed. See the non-secret diagnostic artifact.\n" >&2' ERR

REMOTE_HOST="${LETTA_SSH_HOST:-ax.hni-gl.ai}"
REMOTE_PORT="${LETTA_SSH_PORT:-3004}"
REMOTE_USER="${LETTA_SSH_USER:-since98kr}"
BRIDGE_USER="${LETTA_BRIDGE_USER:-since98kr}"
RESTRICTED_MODE="${LETTA_SSH_RESTRICTED_MODE:-false}"
SSH_BIN="${LETTA_SSH_BIN:-ssh}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIAGNOSTIC_PATH="${LETTA_BRIDGE_DEPLOY_DIAGNOSTIC_PATH:-}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'LETTA_SSH_HOST contains unsafe characters.' >&2; exit 1; }
[[ "${REMOTE_PORT}" =~ ^[0-9]{1,5}$ ]] || { echo 'LETTA_SSH_PORT must be numeric.' >&2; exit 1; }
[[ "${REMOTE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'LETTA_SSH_USER contains unsafe characters.' >&2; exit 1; }
[[ "${BRIDGE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'LETTA_BRIDGE_USER contains unsafe characters.' >&2; exit 1; }
[[ "${RESTRICTED_MODE}" == 'true' || "${RESTRICTED_MODE}" == 'false' ]] || { echo 'LETTA_SSH_RESTRICTED_MODE must be true or false.' >&2; exit 1; }

for command in "${SSH_BIN}" tar curl node; do
  command -v "${command}" >/dev/null || { echo "${command} is required" >&2; exit 1; }
done
[[ -f "${SOURCE_DIR}/letta-cli-bridge.mjs" ]] || { echo 'letta-cli-bridge.mjs not found' >&2; exit 1; }
if [[ "${RESTRICTED_MODE}" == 'false' ]]; then
  [[ -f "${SOURCE_DIR}/rollout-user-owned.sh" ]] || { echo 'rollout-user-owned.sh not found' >&2; exit 1; }
fi

IDENTITY_SOURCE='runner-default'
KNOWN_HOSTS_SOURCE='runner-default'
SSH=(
  "${SSH_BIN}" -p "${REMOTE_PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=3
)

if [[ -n "${LETTA_SSH_PRIVATE_KEY:-}" ]]; then
  IDENTITY_SOURCE='staging-environment-secret'
  KEY_FILE="${TMP_DIR}/identity"
  umask 077
  printf '%s\n' "${LETTA_SSH_PRIVATE_KEY}" >"${KEY_FILE}"
  chmod 0600 "${KEY_FILE}"
  SSH+=( -i "${KEY_FILE}" -o IdentitiesOnly=yes )
fi

if [[ -n "${LETTA_SSH_KNOWN_HOSTS:-}" ]]; then
  KNOWN_HOSTS_SOURCE='staging-environment-secret'
  KNOWN_HOSTS_FILE="${TMP_DIR}/known_hosts"
  umask 077
  printf '%s\n' "${LETTA_SSH_KNOWN_HOSTS}" >"${KNOWN_HOSTS_FILE}"
  chmod 0600 "${KNOWN_HOSTS_FILE}"
  SSH+=( -o "UserKnownHostsFile=${KNOWN_HOSTS_FILE}" )
fi
SSH+=( "${REMOTE_USER}@${REMOTE_HOST}" )

write_diagnostic() {
  local category="$1" exit_code="$2" stage="$3"
  [[ -n "${DIAGNOSTIC_PATH}" ]] || return 0
  mkdir -p "$(dirname "${DIAGNOSTIC_PATH}")"
  CATEGORY="${category}" EXIT_CODE="${exit_code}" STAGE="${stage}" \
  RUNNER_USER="$(id -un)" REMOTE_USER_SAFE="${REMOTE_USER}" BRIDGE_USER_SAFE="${BRIDGE_USER}" \
  IDENTITY_SOURCE_SAFE="${IDENTITY_SOURCE}" KNOWN_HOSTS_SOURCE_SAFE="${KNOWN_HOSTS_SOURCE}" \
  RESTRICTED_MODE_SAFE="${RESTRICTED_MODE}" \
  node - "${DIAGNOSTIC_PATH}" <<'NODE'
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  ok: process.env.CATEGORY === 'success',
  stage: process.env.STAGE,
  category: process.env.CATEGORY,
  exit_code: Number(process.env.EXIT_CODE),
  runner_user: process.env.RUNNER_USER,
  remote_user: process.env.REMOTE_USER_SAFE,
  bridge_user: process.env.BRIDGE_USER_SAFE,
  identity_source: process.env.IDENTITY_SOURCE_SAFE,
  known_hosts_source: process.env.KNOWN_HOSTS_SOURCE_SAFE,
  restricted_mode: process.env.RESTRICTED_MODE_SAFE === 'true',
  checked_at: new Date().toISOString(),
}, null, 2) + '\n', { mode: 0o600 });
NODE
}

classify_failure() {
  local exit_code="$1" error_file="$2" default_category="$3"
  local category="${default_category}"
  case "${exit_code}" in
    31) category='remote-identity' ;;
    32) category='remote-environment' ;;
    33) category='remote-target' ;;
    34|35|36|64) category='restricted-gate' ;;
    *)
      if grep -Eqi 'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED' "${error_file}"; then
        category='ssh-host-key-verification'
      elif grep -Eqi 'Permission denied|no mutual signature algorithm|Too many authentication failures' "${error_file}"; then
        category='ssh-authentication'
      elif grep -Eqi 'Could not resolve hostname|Connection timed out|Operation timed out|No route to host|Connection refused|Network is unreachable' "${error_file}"; then
        category='ssh-connectivity'
      fi
      ;;
  esac
  printf '%s\n' "${category}"
}

run_ssh_preflight() {
  local error_file="${TMP_DIR}/ssh-preflight.err"
  local remote_command
  if [[ "${RESTRICTED_MODE}" == 'true' ]]; then
    remote_command='letta-preflight-v1'
  else
    remote_command="set -Eeuo pipefail; [[ \"\$(id -un)\" == '${BRIDGE_USER}' ]] || exit 31; test -r ~/.config/letta-bridge.env || exit 32; test -f ~/.local/share/letta-bridge/letta-bridge.mjs && test ! -L ~/.local/share/letta-bridge/letta-bridge.mjs && test -w ~/.local/share/letta-bridge/letta-bridge.mjs || exit 33"
  fi

  set +e
  "${SSH[@]}" "${remote_command}" >/dev/null 2>"${error_file}"
  local status=$?
  set -e
  if [[ "${status}" -ne 0 ]]; then
    local category
    category="$(classify_failure "${status}" "${error_file}" 'ssh-preflight')"
    write_diagnostic "${category}" "${status}" 'ssh-preflight'
    printf 'Letta bridge SSH preflight failed: %s (exit %s).\n' "${category}" "${status}" >&2
    return 1
  fi
}

printf 'Checking staging-runner SSH access to %s@%s:%s using %s identity (%s mode)...\n' \
  "${REMOTE_USER}" "${REMOTE_HOST}" "${REMOTE_PORT}" "${IDENTITY_SOURCE}" \
  "$([[ "${RESTRICTED_MODE}" == 'true' ]] && printf restricted || printf legacy)"
run_ssh_preflight

printf 'Deploying exact full Letta CLI bridge without remote sudo...\n'
ROLLOUT_ERROR="${TMP_DIR}/ssh-rollout.err"
set +e
if [[ "${RESTRICTED_MODE}" == 'true' ]]; then
  tar -C "${SOURCE_DIR}" -cf - letta-cli-bridge.mjs \
    | "${SSH[@]}" letta-rollout-v1 >/dev/null 2>"${ROLLOUT_ERROR}"
  ROLLOUT_STATUS=$?
else
  tar -C "${SOURCE_DIR}" -cf - letta-cli-bridge.mjs rollout-user-owned.sh \
    | "${SSH[@]}" "set -Eeuo pipefail; tmp=\$(mktemp -d); trap 'rm -rf \"\${tmp}\"' EXIT; tar -C \"\${tmp}\" -xf -; chmod 0755 \"\${tmp}/rollout-user-owned.sh\"; LETTA_BRIDGE_USER='${BRIDGE_USER}' bash \"\${tmp}/rollout-user-owned.sh\" \"\${tmp}/letta-cli-bridge.mjs\"" \
      >/dev/null 2>"${ROLLOUT_ERROR}"
  ROLLOUT_STATUS=$?
fi
set -e
if [[ "${ROLLOUT_STATUS}" -ne 0 ]]; then
  ROLLOUT_CATEGORY="$(classify_failure "${ROLLOUT_STATUS}" "${ROLLOUT_ERROR}" 'remote-rollout')"
  write_diagnostic "${ROLLOUT_CATEGORY}" "${ROLLOUT_STATUS}" 'remote-rollout'
  printf 'Letta bridge rollout failed: %s (exit %s).\n' "${ROLLOUT_CATEGORY}" "${ROLLOUT_STATUS}" >&2
  exit 1
fi

BASE_URL="${LETTA_BASE_URL:-http://host.docker.internal:18283}"
if [[ "${BASE_URL}" == *'host.docker.internal'* ]] && ! getent hosts host.docker.internal >/dev/null 2>&1; then
  command -v docker >/dev/null || {
    write_diagnostic 'gateway-resolution' 1 'gateway-health'
    echo 'Docker is required to resolve host.docker.internal through the bridge gateway.' >&2
    exit 1
  }
  DOCKER_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  [[ -n "${DOCKER_GATEWAY}" ]] || {
    write_diagnostic 'gateway-resolution' 1 'gateway-health'
    echo 'Docker bridge gateway was not resolved.' >&2
    exit 1
  }
  BASE_URL="${BASE_URL/host.docker.internal/${DOCKER_GATEWAY}}"
fi

set +e
HEALTH="$(curl --fail --silent --show-error "${BASE_URL%/}/health" 2>/dev/null)"
HEALTH_STATUS=$?
set -e
if [[ "${HEALTH_STATUS}" -ne 0 ]] || ! node -e '
  const health=JSON.parse(process.argv[1]);
  if (!health.ok || health.mode !== "full-cli-runtime") process.exit(1);
' "${HEALTH}"; then
  write_diagnostic 'gateway-health' "${HEALTH_STATUS}" 'gateway-health'
  echo 'Full Letta CLI bridge did not pass gateway health verification.' >&2
  exit 1
fi

if [[ -n "${LETTA_BRIDGE_EVIDENCE_PATH:-}" ]]; then
  mkdir -p "$(dirname "${LETTA_BRIDGE_EVIDENCE_PATH}")"
  printf '%s\n' "${HEALTH}" >"${LETTA_BRIDGE_EVIDENCE_PATH}"
fi
write_diagnostic 'success' 0 'complete'
printf 'Full Letta CLI bridge health verified through %s.\n' "${BASE_URL%/}"
