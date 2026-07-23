#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "Restricted staging SSH bootstrap failed at line %s.\n" "${LINENO}" >&2' ERR

REPO="${GITHUB_REPOSITORY:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${GITHUB_ENVIRONMENT:-staging}"
REMOTE_HOST="${LETTA_SSH_HOST:-ax.hni-gl.ai}"
REMOTE_PORT="${LETTA_SSH_PORT:-3004}"
REMOTE_USER="${LETTA_SSH_USER:-since98kr}"
BRIDGE_USER="${LETTA_BRIDGE_USER:-since98kr}"
TUNNEL_SERVICE="${LETTA_TUNNEL_SERVICE:-letta-bridge-tunnel.service}"
TRUSTED_KNOWN_HOSTS="${LETTA_TRUSTED_KNOWN_HOSTS:-${HOME}/.ssh/known_hosts}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

fail() {
  printf '[letta-staging-ssh-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -ne 0 ]] || fail 'run as the existing non-root trusted tunnel user, not root'
[[ "${REMOTE_HOST}" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'invalid remote host'
[[ "${REMOTE_PORT}" =~ ^[0-9]{1,5}$ ]] || fail 'invalid remote port'
[[ "${REMOTE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid remote user'
[[ "${BRIDGE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid bridge user'
[[ "${REMOTE_USER}" == "${BRIDGE_USER}" ]] || fail 'remote and bridge user must match for the restricted gate'

for command in gh ssh ssh-keygen systemctl tar install node; do
  command -v "${command}" >/dev/null || fail "${command} is required"
done
[[ -f "${SOURCE_DIR}/authorized-rollout-gate.sh" ]] || fail 'authorized-rollout-gate.sh not found'
[[ -f "${SOURCE_DIR}/rollout-user-owned.sh" ]] || fail 'rollout-user-owned.sh not found'
[[ -r "${TRUSTED_KNOWN_HOSTS}" && ! -L "${TRUSTED_KNOWN_HOSTS}" ]] || fail 'trusted known_hosts is unavailable'

gh auth status >/dev/null

TUNNEL_USER="$(systemctl show --property User --value "${TUNNEL_SERVICE}" | tr -d '[:space:]')"
TUNNEL_EXEC="$(systemctl show --property ExecStart --value "${TUNNEL_SERVICE}")"
[[ "$(systemctl is-active "${TUNNEL_SERVICE}")" == 'active' ]] || fail 'trusted Letta tunnel is not active'
[[ "${TUNNEL_USER}" == "$(id -un)" ]] || fail 'current user is not the active trusted tunnel user'
[[ "${TUNNEL_EXEC}" == *'StrictHostKeyChecking=yes'* ]] || fail 'active tunnel does not enforce strict host-key checking'
[[ "${TUNNEL_EXEC}" == *"-p ${REMOTE_PORT}"* ]] || fail 'active tunnel uses a different remote port'
[[ "${TUNNEL_EXEC}" == *"${REMOTE_USER}@${REMOTE_HOST}"* ]] || fail 'active tunnel uses a different remote identity'

HOST_TOKEN="[${REMOTE_HOST}]:${REMOTE_PORT}"
TRUSTED_ENTRY_FILE="${TMP_DIR}/known_hosts"
ssh-keygen -F "${HOST_TOKEN}" -f "${TRUSTED_KNOWN_HOSTS}" \
  | awk '!/^#/ && NF >= 3 { print }' >"${TRUSTED_ENTRY_FILE}"
[[ -s "${TRUSTED_ENTRY_FILE}" ]] || fail "no trusted known_hosts entry exists for ${HOST_TOKEN}"
chmod 0600 "${TRUSTED_ENTRY_FILE}"

SSH_TRUSTED=(
  ssh -p "${REMOTE_PORT}"
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TRUSTED_ENTRY_FILE}"
  "${REMOTE_USER}@${REMOTE_HOST}"
)
"${SSH_TRUSTED[@]}" true >/dev/null || fail 'existing trusted SSH identity could not validate the remote host'

KEY_FILE="${TMP_DIR}/chat-staging-letta-deploy"
ssh-keygen -q -t ed25519 -N '' -C 'chat-staging-letta-deploy' -f "${KEY_FILE}"
chmod 0600 "${KEY_FILE}"
PUBLIC_KEY_FILE="${KEY_FILE}.pub"
ssh-keygen -lf "${PUBLIC_KEY_FILE}" -E sha256 >/dev/null

PACKAGE_DIR="${TMP_DIR}/package"
mkdir -p "${PACKAGE_DIR}"
install -m 0755 "${SOURCE_DIR}/authorized-rollout-gate.sh" "${PACKAGE_DIR}/authorized-rollout-gate.sh"
install -m 0755 "${SOURCE_DIR}/rollout-user-owned.sh" "${PACKAGE_DIR}/rollout-user-owned.sh"
install -m 0600 "${PUBLIC_KEY_FILE}" "${PACKAGE_DIR}/deploy-key.pub"

printf 'Installing restricted forced-command key through the existing trusted SSH path...\n'
tar -C "${PACKAGE_DIR}" -cf - authorized-rollout-gate.sh rollout-user-owned.sh deploy-key.pub \
  | "${SSH_TRUSTED[@]}" 'set -Eeuo pipefail
      install_dir="$HOME/.local/share/letta-bridge"
      ssh_dir="$HOME/.ssh"
      tmp="$(mktemp -d)"
      trap '\''rm -rf "$tmp"'\'' EXIT
      tar -C "$tmp" -xf -
      [[ "$(tar -C "$tmp" -cf - authorized-rollout-gate.sh rollout-user-owned.sh deploy-key.pub | tar -tf - | wc -l)" -eq 3 ]]
      install -d -m 0755 "$install_dir"
      install -m 0755 "$tmp/authorized-rollout-gate.sh" "$install_dir/authorized-rollout-gate.sh"
      install -m 0755 "$tmp/rollout-user-owned.sh" "$install_dir/rollout-user-owned.sh"
      install -d -m 0700 "$ssh_dir"
      touch "$ssh_dir/authorized_keys"
      chmod 0600 "$ssh_dir/authorized_keys"
      public_key="$(cat "$tmp/deploy-key.pub")"
      [[ "$public_key" == ssh-ed25519\ *\ chat-staging-letta-deploy ]]
      grep -vE "[[:space:]]chat-staging-letta-deploy$" "$ssh_dir/authorized_keys" >"$tmp/authorized_keys" || true
      printf '\''restrict,command="%s/authorized-rollout-gate.sh" %s\n'\'' "$install_dir" "$public_key" >>"$tmp/authorized_keys"
      install -m 0600 "$tmp/authorized_keys" "$ssh_dir/authorized_keys"'

SSH_RESTRICTED=(
  ssh -p "${REMOTE_PORT}"
  -i "${KEY_FILE}"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TRUSTED_ENTRY_FILE}"
  "${REMOTE_USER}@${REMOTE_HOST}"
)
PREFLIGHT_RESULT="$("${SSH_RESTRICTED[@]}" letta-preflight-v1)"
[[ "${PREFLIGHT_RESULT}" == 'letta-preflight-v1:ok' ]] || fail 'restricted deployment key did not pass its forced-command preflight'

printf 'Writing restricted identity and trusted host entry to GitHub staging Environment...\n'
gh api --method PUT "repos/${REPO}/environments/${ENVIRONMENT}" --silent

gh secret set LETTA_SSH_PRIVATE_KEY --repo "${REPO}" --env "${ENVIRONMENT}" <"${KEY_FILE}"
gh secret set LETTA_SSH_KNOWN_HOSTS --repo "${REPO}" --env "${ENVIRONMENT}" <"${TRUSTED_ENTRY_FILE}"
gh variable set LETTA_SSH_RESTRICTED_MODE --body 'true' --repo "${REPO}" --env "${ENVIRONMENT}"

printf 'Restricted staging SSH access enrolled. Private material was not printed and will be removed with the temporary directory.\n'
printf 'Dispatching exact main staging verification...\n'
gh workflow run deploy-staging.yml --repo "${REPO}" --ref main -f ref=main
