#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="${ROOT}/ops/letta-bridge/authorized-rollout-gate.sh"
CANONICAL="${ROOT}/ops/letta-bridge/letta-cli-bridge.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${TMP}/${label}.out" 2>"${TMP}/${label}.err"; then
    echo "expected failure but command passed: ${label}" >&2
    exit 1
  fi
}

HOME_DIR="${TMP}/home"
INSTALL_DIR="${HOME_DIR}/.local/share/letta-bridge"
CONFIG_DIR="${HOME_DIR}/.config"
mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}"
printf '%s\n' 'LETTA_BRIDGE_TOKEN=redacted' >"${CONFIG_DIR}/letta-bridge.env"
printf '%s\n' '#!/usr/bin/env node' 'console.log("old")' >"${INSTALL_DIR}/letta-bridge.mjs"
chmod 0755 "${INSTALL_DIR}/letta-bridge.mjs"

cat >"${INSTALL_DIR}/rollout-user-owned.sh" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
source_file="$1"
cp "$source_file" "${HOME}/.local/share/letta-bridge/received.mjs"
SH
chmod 0755 "${INSTALL_DIR}/rollout-user-owned.sh"

run_gate() {
  local command="$1"
  shift
  env HOME="${HOME_DIR}" LETTA_BRIDGE_USER="$(id -un)" SSH_ORIGINAL_COMMAND="${command}" \
    bash "${GATE}" "$@"
}

[[ "$(run_gate letta-preflight-v1)" == 'letta-preflight-v1:ok' ]]
expect_failure arbitrary run_gate 'bash -lc id'
grep -Fq 'command is not authorized' "${TMP}/arbitrary.err"

VALID_TAR="${TMP}/valid.tar"
tar -C "$(dirname "${CANONICAL}")" -cf "${VALID_TAR}" "$(basename "${CANONICAL}")"
run_gate letta-rollout-v1 <"${VALID_TAR}"
cmp "${CANONICAL}" "${INSTALL_DIR}/received.mjs"

EXTRA_DIR="${TMP}/extra"
mkdir -p "${EXTRA_DIR}"
cp "${CANONICAL}" "${EXTRA_DIR}/letta-cli-bridge.mjs"
printf '%s\n' 'unexpected' >"${EXTRA_DIR}/extra.txt"
tar -C "${EXTRA_DIR}" -cf "${TMP}/extra.tar" letta-cli-bridge.mjs extra.txt
expect_failure extra bash -c 'cat "$1" | "$2"' _ "${TMP}/extra.tar" "$(printf '%q' env)"
if env HOME="${HOME_DIR}" LETTA_BRIDGE_USER="$(id -un)" SSH_ORIGINAL_COMMAND=letta-rollout-v1 \
  bash "${GATE}" <"${TMP}/extra.tar" >"${TMP}/extra-direct.out" 2>"${TMP}/extra-direct.err"; then
  echo 'extra archive unexpectedly passed' >&2
  exit 1
fi
grep -Fq 'payload must contain exactly letta-cli-bridge.mjs' "${TMP}/extra-direct.err"

SYMLINK_DIR="${TMP}/symlink"
mkdir -p "${SYMLINK_DIR}"
ln -s /etc/passwd "${SYMLINK_DIR}/letta-cli-bridge.mjs"
tar -C "${SYMLINK_DIR}" -cf "${TMP}/symlink.tar" letta-cli-bridge.mjs
if env HOME="${HOME_DIR}" LETTA_BRIDGE_USER="$(id -un)" SSH_ORIGINAL_COMMAND=letta-rollout-v1 \
  bash "${GATE}" <"${TMP}/symlink.tar" >"${TMP}/symlink.out" 2>"${TMP}/symlink.err"; then
  echo 'symlink archive unexpectedly passed' >&2
  exit 1
fi
grep -Fq 'payload member must be a regular file' "${TMP}/symlink.err"

printf '%s\n' '[authorized-rollout-gate-nodecheck] PASS'
