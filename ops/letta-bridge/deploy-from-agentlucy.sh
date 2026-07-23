#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Full Letta bridge staging deployment failed at line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

REMOTE_HOST="${LETTA_SSH_HOST:-ax.hni-gl.ai}"
REMOTE_PORT="${LETTA_SSH_PORT:-3004}"
REMOTE_USER="${LETTA_SSH_USER:-since98kr}"
BRIDGE_USER="${LETTA_BRIDGE_USER:-since98kr}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'LETTA_SSH_HOST contains unsafe characters.' >&2; exit 1; }
[[ "${REMOTE_PORT}" =~ ^[0-9]{1,5}$ ]] || { echo 'LETTA_SSH_PORT must be numeric.' >&2; exit 1; }
[[ "${REMOTE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'LETTA_SSH_USER contains unsafe characters.' >&2; exit 1; }
[[ "${BRIDGE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'LETTA_BRIDGE_USER contains unsafe characters.' >&2; exit 1; }

for command in ssh tar curl node; do
  command -v "${command}" >/dev/null || { echo "${command} is required" >&2; exit 1; }
done
[[ -f "${SOURCE_DIR}/letta-cli-bridge.mjs" ]] || { echo 'letta-cli-bridge.mjs not found' >&2; exit 1; }
[[ -f "${SOURCE_DIR}/rollout-user-owned.sh" ]] || { echo 'rollout-user-owned.sh not found' >&2; exit 1; }

SSH=(
  ssh -p "${REMOTE_PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=3
  "${REMOTE_USER}@${REMOTE_HOST}"
)

printf 'Checking staging-runner SSH access to %s@%s:%s...\n' "${REMOTE_USER}" "${REMOTE_HOST}" "${REMOTE_PORT}"
"${SSH[@]}" "set -Eeuo pipefail; [[ \"\$(id -un)\" == '${BRIDGE_USER}' ]]; test -r ~/.config/letta-bridge.env; test -w ~/.local/share/letta-bridge/letta-bridge.mjs" >/dev/null

printf 'Deploying exact full Letta CLI bridge without remote sudo...\n'
tar -C "${SOURCE_DIR}" -cf - letta-cli-bridge.mjs rollout-user-owned.sh \
  | "${SSH[@]}" "set -Eeuo pipefail; tmp=\$(mktemp -d); trap 'rm -rf \"\${tmp}\"' EXIT; tar -C \"\${tmp}\" -xf -; chmod 0755 \"\${tmp}/rollout-user-owned.sh\"; LETTA_BRIDGE_USER='${BRIDGE_USER}' bash \"\${tmp}/rollout-user-owned.sh\" \"\${tmp}/letta-cli-bridge.mjs\""

BASE_URL="${LETTA_BASE_URL:-http://host.docker.internal:18283}"
if [[ "${BASE_URL}" == *'host.docker.internal'* ]] && ! getent hosts host.docker.internal >/dev/null 2>&1; then
  command -v docker >/dev/null || {
    echo 'Docker is required to resolve host.docker.internal through the bridge gateway.' >&2
    exit 1
  }
  DOCKER_GATEWAY="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
  [[ -n "${DOCKER_GATEWAY}" ]] || { echo 'Docker bridge gateway was not resolved.' >&2; exit 1; }
  BASE_URL="${BASE_URL/host.docker.internal/${DOCKER_GATEWAY}}"
fi

HEALTH="$(curl --fail --silent --show-error "${BASE_URL%/}/health")"
node -e '
  const health=JSON.parse(process.argv[1]);
  if (!health.ok || health.mode !== "full-cli-runtime") process.exit(1);
' "${HEALTH}"
if [[ -n "${LETTA_BRIDGE_EVIDENCE_PATH:-}" ]]; then
  mkdir -p "$(dirname "${LETTA_BRIDGE_EVIDENCE_PATH}")"
  printf '%s\n' "${HEALTH}" >"${LETTA_BRIDGE_EVIDENCE_PATH}"
fi
printf 'Full Letta CLI bridge health verified through %s.\n' "${BASE_URL%/}"
