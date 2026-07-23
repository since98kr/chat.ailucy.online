#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_FILE="${1:?Usage: rollout-user-owned.sh <canonical-bridge-file>}"
EXPECTED_USER="${LETTA_BRIDGE_USER:-$(id -un)}"
SERVICE="${LETTA_BRIDGE_SERVICE:-letta-bridge.service}"
INSTALL_DIR="${LETTA_BRIDGE_INSTALL_DIR:-${HOME}/.local/share/letta-bridge}"
TARGET="${INSTALL_DIR}/letta-bridge.mjs"
BACKUP="${INSTALL_DIR}/letta-bridge.mjs.pre-full-cli"
PORT="${LETTA_BRIDGE_PORT:-18283}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
CURL_BIN="${CURL_BIN:-curl}"
NODE_BIN="${NODE_BIN:-node}"
KILL_BIN="${KILL_BIN:-/bin/kill}"

log() {
  printf '[letta-user-rollout] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

[[ "${EXPECTED_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'LETTA_BRIDGE_USER is invalid'
[[ "$(id -un)" == "${EXPECTED_USER}" ]] || fail "remote identity mismatch: expected ${EXPECTED_USER}"
[[ "${EUID}" -ne 0 ]] || fail 'normal staging rollout must not run as root'
[[ -f "${SOURCE_FILE}" && ! -L "${SOURCE_FILE}" ]] || fail 'canonical bridge source must be a regular file'

HOME_REAL="$(realpath -e "${HOME}")"
INSTALL_REAL="$(realpath -e "${INSTALL_DIR}")"
TARGET_REAL="$(realpath -e "${TARGET}")"
[[ "${INSTALL_REAL}" == "${HOME_REAL}/.local/share/letta-bridge" ]] \
  || fail 'bridge install directory is outside the expected user home namespace'
[[ "${TARGET_REAL}" == "${INSTALL_REAL}/letta-bridge.mjs" ]] \
  || fail 'bridge target path is not the installed service path'
[[ -f "${TARGET}" && ! -L "${TARGET}" && -w "${TARGET}" ]] \
  || fail 'installed bridge target must be a writable regular file'
[[ "$(stat -c '%u' "${TARGET}")" == "$(id -u)" ]] \
  || fail 'installed bridge target is not owned by the remote Lucy user'

"${NODE_BIN}" --check "${SOURCE_FILE}" >/dev/null

main_pid() {
  "${SYSTEMCTL_BIN}" show --property MainPID --value "${SERVICE}" 2>/dev/null | tr -d '[:space:]'
}

validate_pid() {
  local pid="$1"
  [[ "${pid}" =~ ^[0-9]+$ && "${pid}" -gt 1 && -d "/proc/${pid}" ]] \
    || fail "${SERVICE} does not have a live MainPID"
  [[ "$(stat -c '%u' "/proc/${pid}")" == "$(id -u)" ]] \
    || fail 'bridge service MainPID is not owned by the remote Lucy user'
  local command_line
  command_line="$(tr '\0' ' ' <"/proc/${pid}/cmdline")"
  [[ "${command_line}" == *"${TARGET}"* ]] \
    || fail 'bridge service MainPID does not execute the expected installed path'
}

health_mode() {
  local expected_mode="$1"
  local payload
  payload="$(${CURL_BIN} --fail --silent --show-error --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)" \
    || return 1
  "${NODE_BIN}" -e '
    const value=JSON.parse(process.argv[1]);
    const expected=process.argv[2];
    if (!value.ok) process.exit(1);
    if (expected && value.mode !== expected) process.exit(1);
  ' "${payload}" "${expected_mode}"
}

wait_for_health() {
  local expected_mode="$1" attempts="${2:-30}"
  local attempt
  for attempt in $(seq 1 "${attempts}"); do
    if health_mode "${expected_mode}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_verified_process() {
  local pid
  pid="$(main_pid)"
  validate_pid "${pid}"
  "${KILL_BIN}" -KILL "${pid}"
}

rollback() {
  local reason="$1"
  log "New bridge failed (${reason}); restoring the previous user-owned bridge."
  [[ -f "${BACKUP}" && ! -L "${BACKUP}" ]] || fail 'rollback copy is unavailable'
  local restore_tmp="${INSTALL_DIR}/.letta-bridge.rollback.$$"
  install -m 0755 "${BACKUP}" "${restore_tmp}"
  mv -f "${restore_tmp}" "${TARGET}"

  local pid
  pid="$(main_pid || true)"
  if [[ "${pid}" =~ ^[0-9]+$ && "${pid}" -gt 1 && -d "/proc/${pid}" ]]; then
    validate_pid "${pid}"
    "${KILL_BIN}" -KILL "${pid}" || true
  fi
  wait_for_health '' 30 || fail 'previous bridge was restored but did not become healthy'
  fail 'full CLI bridge rollout was rolled back'
}

CURRENT_PID="$(main_pid)"
validate_pid "${CURRENT_PID}"

backup_tmp="${INSTALL_DIR}/.letta-bridge.backup.$$"
incoming_tmp="${INSTALL_DIR}/.letta-bridge.incoming.$$"
trap 'rm -f "${backup_tmp}" "${incoming_tmp}"' EXIT
install -m 0755 "${TARGET}" "${backup_tmp}"
mv -f "${backup_tmp}" "${BACKUP}"
install -m 0755 "${SOURCE_FILE}" "${incoming_tmp}"
mv -f "${incoming_tmp}" "${TARGET}"

log "Installed canonical bridge atomically; restarting verified PID ${CURRENT_PID}."
"${KILL_BIN}" -KILL "${CURRENT_PID}" || rollback 'process restart signal failed'
wait_for_health 'full-cli-runtime' 30 || rollback 'full-cli-runtime health did not pass'

log 'Full CLI bridge rollout completed without sudo or systemd unit mutation.'
