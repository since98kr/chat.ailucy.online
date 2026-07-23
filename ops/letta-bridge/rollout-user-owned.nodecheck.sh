#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROLLOUT="${ROOT}/ops/letta-bridge/rollout-user-owned.sh"
SOURCE="${ROOT}/ops/letta-bridge/letta-cli-bridge.mjs"
TMP="$(mktemp -d)"
PIDS=()
trap 'for pid in "${PIDS[@]}"; do kill "${pid}" >/dev/null 2>&1 || true; done; rm -rf "${TMP}"' EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${TMP}/${label}.out" 2>"${TMP}/${label}.err"; then
    echo "expected failure but command passed: ${label}" >&2
    exit 1
  fi
}

FAKE_BIN="${TMP}/bin"
mkdir -p "${FAKE_BIN}"
cat >"${FAKE_BIN}/systemctl" <<'SH'
#!/usr/bin/env bash
cat "${FAKE_PID_FILE}"
SH
cat >"${FAKE_BIN}/kill" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_KILL_LOG}"
SH
cat >"${FAKE_BIN}/curl" <<'SH'
#!/usr/bin/env bash
if grep -Fq 'full-cli-runtime' "${FAKE_TARGET}"; then
  if [[ "${FAKE_FAIL_NEW:-false}" == 'true' ]]; then
    exit 22
  fi
  printf '%s\n' '{"ok":true,"mode":"full-cli-runtime"}'
else
  printf '%s\n' '{"ok":true,"status":"ok"}'
fi
SH
chmod 0755 "${FAKE_BIN}"/*

make_runtime() {
  local root="$1"
  local home="${root}/home"
  local install_dir="${home}/.local/share/letta-bridge"
  mkdir -p "${install_dir}"
  cat >"${install_dir}/letta-bridge.mjs" <<'SH'
#!/usr/bin/env bash
while :; do sleep 60; done
SH
  chmod 0755 "${install_dir}/letta-bridge.mjs"
  bash "${install_dir}/letta-bridge.mjs" &
  local pid=$!
  PIDS+=("${pid}")
  printf '%s\n' "${pid}" >"${root}/pid"
}

run_rollout() {
  local root="$1"
  shift
  local home="${root}/home"
  local target="${home}/.local/share/letta-bridge/letta-bridge.mjs"
  env \
    HOME="${home}" \
    LETTA_BRIDGE_USER="$(id -un)" \
    LETTA_ROLLOUT_HEALTH_ATTEMPTS=2 \
    LETTA_ROLLOUT_HEALTH_INTERVAL_SECONDS=0 \
    SYSTEMCTL_BIN="${FAKE_BIN}/systemctl" \
    CURL_BIN="${FAKE_BIN}/curl" \
    KILL_BIN="${FAKE_BIN}/kill" \
    NODE_BIN="$(command -v node)" \
    FAKE_PID_FILE="${root}/pid" \
    FAKE_KILL_LOG="${root}/kill.log" \
    FAKE_TARGET="${target}" \
    "$@" \
    bash "${ROLLOUT}" "${SOURCE}"
}

SUCCESS="${TMP}/success"
make_runtime "${SUCCESS}"
run_rollout "${SUCCESS}"
grep -Fq 'full-cli-runtime' "${SUCCESS}/home/.local/share/letta-bridge/letta-bridge.mjs"
grep -Fq 'while :; do sleep 60; done' "${SUCCESS}/home/.local/share/letta-bridge/letta-bridge.mjs.pre-full-cli"
grep -Fq -- '-KILL' "${SUCCESS}/kill.log"

ROLLBACK="${TMP}/rollback"
make_runtime "${ROLLBACK}"
if run_rollout "${ROLLBACK}" FAKE_FAIL_NEW=true >"${TMP}/rollback.out" 2>"${TMP}/rollback.err"; then
  echo 'expected rollback rollout to fail after restoring the prior bridge' >&2
  exit 1
fi
grep -Fq 'while :; do sleep 60; done' "${ROLLBACK}/home/.local/share/letta-bridge/letta-bridge.mjs"
grep -Fq 'full CLI bridge rollout was rolled back' "${TMP}/rollback.err"

WRONG_PID="${TMP}/wrong-pid"
make_runtime "${WRONG_PID}"
sleep 60 &
BAD_PID=$!
PIDS+=("${BAD_PID}")
printf '%s\n' "${BAD_PID}" >"${WRONG_PID}/pid"
expect_failure wrong-pid run_rollout "${WRONG_PID}"
grep -Fq 'does not execute the expected installed path' "${TMP}/wrong-pid.err"

SYMLINK="${TMP}/symlink"
mkdir -p "${SYMLINK}/home/.local/share/letta-bridge"
printf '%s\n' '#!/usr/bin/env bash' >"${SYMLINK}/outside"
ln -s "${SYMLINK}/outside" "${SYMLINK}/home/.local/share/letta-bridge/letta-bridge.mjs"
printf '%s\n' "$$" >"${SYMLINK}/pid"
expect_failure symlink run_rollout "${SYMLINK}"
grep -Eq 'target path is not the installed service path|writable regular file' "${TMP}/symlink.err"

printf '%s\n' '[letta-user-rollout-nodecheck] PASS'
