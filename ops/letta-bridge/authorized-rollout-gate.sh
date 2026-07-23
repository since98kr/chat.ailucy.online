#!/usr/bin/env bash
set -Eeuo pipefail

COMMAND="${SSH_ORIGINAL_COMMAND:-}"
EXPECTED_USER="${LETTA_BRIDGE_USER:-$(id -un)}"
INSTALL_DIR="${HOME}/.local/share/letta-bridge"
TARGET="${INSTALL_DIR}/letta-bridge.mjs"
ENV_FILE="${HOME}/.config/letta-bridge.env"
ROLLOUT="${INSTALL_DIR}/rollout-user-owned.sh"
MAX_PAYLOAD_BYTES="${LETTA_ROLLOUT_MAX_PAYLOAD_BYTES:-2097152}"
ROLLOUT_TMP=''

cleanup() {
  if [[ -n "${ROLLOUT_TMP}" ]]; then
    rm -rf -- "${ROLLOUT_TMP}"
  fi
}
trap cleanup EXIT

fail() {
  printf '[letta-rollout-gate] denied: %s\n' "$*" >&2
  exit 64
}

[[ "${EUID}" -ne 0 ]] || fail 'root execution is forbidden'
[[ "${EXPECTED_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'invalid expected user'
[[ "$(id -un)" == "${EXPECTED_USER}" ]] || fail 'remote identity mismatch'
[[ "${MAX_PAYLOAD_BYTES}" =~ ^[1-9][0-9]*$ ]] || fail 'invalid payload limit'

preflight() {
  [[ -r "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || exit 32
  [[ -f "${TARGET}" && ! -L "${TARGET}" && -w "${TARGET}" ]] || exit 33
  [[ -f "${ROLLOUT}" && ! -L "${ROLLOUT}" && -x "${ROLLOUT}" ]] || exit 34
  [[ "$(stat -c '%u' "${TARGET}")" == "$(id -u)" ]] || exit 35
  [[ "$(stat -c '%u' "${ROLLOUT}")" == "$(id -u)" ]] || exit 36
  printf '%s\n' 'letta-preflight-v1:ok'
}

validate_archive() {
  local archive="$1"
  local size
  size="$(stat -c '%s' "${archive}")"
  [[ "${size}" -gt 0 && "${size}" -le "${MAX_PAYLOAD_BYTES}" ]] || fail 'payload size is outside the allowed range'

  mapfile -t entries < <(tar -tf "${archive}")
  [[ "${#entries[@]}" -eq 1 && "${entries[0]}" == 'letta-cli-bridge.mjs' ]] \
    || fail 'payload must contain exactly letta-cli-bridge.mjs'

  local mode
  mode="$(tar -tvf "${archive}" | head -n 1 | cut -c1)"
  [[ "${mode}" == '-' ]] || fail 'payload member must be a regular file'
}

rollout() {
  preflight >/dev/null
  local archive
  ROLLOUT_TMP="$(mktemp -d)"
  archive="${ROLLOUT_TMP}/payload.tar"
  umask 077
  cat >"${archive}"
  validate_archive "${archive}"
  tar --no-same-owner --no-same-permissions -xf "${archive}" -C "${ROLLOUT_TMP}"
  [[ -f "${ROLLOUT_TMP}/letta-cli-bridge.mjs" && ! -L "${ROLLOUT_TMP}/letta-cli-bridge.mjs" ]] \
    || fail 'extracted canonical bridge is invalid'
  LETTA_BRIDGE_USER="${EXPECTED_USER}" bash "${ROLLOUT}" "${ROLLOUT_TMP}/letta-cli-bridge.mjs"
}

case "${COMMAND}" in
  letta-preflight-v1)
    preflight
    ;;
  letta-rollout-v1)
    rollout
    ;;
  *)
    fail 'command is not authorized'
    ;;
esac
