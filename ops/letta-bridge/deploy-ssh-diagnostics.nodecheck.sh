#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="${ROOT}/ops/letta-bridge/deploy-from-agentlucy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

FAKE_SSH="${TMP}/ssh"
cat >"${FAKE_SSH}" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
mode="${FAKE_SSH_MODE:?}"
if [[ "${FAKE_REQUIRE_SECRET_FILES:-false}" == 'true' ]]; then
  key_file=''
  known_hosts=''
  previous=''
  for argument in "$@"; do
    if [[ "${previous}" == '-i' ]]; then
      key_file="${argument}"
    fi
    if [[ "${argument}" == UserKnownHostsFile=* ]]; then
      known_hosts="${argument#UserKnownHostsFile=}"
    fi
    previous="${argument}"
  done
  [[ -n "${key_file}" && -f "${key_file}" && "$(stat -c '%a' "${key_file}")" == '600' ]]
  [[ -n "${known_hosts}" && -f "${known_hosts}" && "$(stat -c '%a' "${known_hosts}")" == '600' ]]
  grep -Fq 'PRIVATE_KEY_SENTINEL' "${key_file}"
  grep -Fq 'KNOWN_HOST_SENTINEL' "${known_hosts}"
fi
case "${mode}" in
  auth) echo 'Permission denied (publickey).' >&2; exit 255 ;;
  host-key) echo 'Host key verification failed.' >&2; exit 255 ;;
  connectivity) echo 'ssh: connect to host example port 22: Connection timed out' >&2; exit 255 ;;
  identity) exit 31 ;;
  environment) exit 32 ;;
  target) exit 33 ;;
  unknown) echo 'opaque ssh failure' >&2; exit 255 ;;
  *) exit 99 ;;
esac
SH
chmod 0755 "${FAKE_SSH}"

run_case() {
  local label="$1" mode="$2" expected="$3"
  shift 3
  local diagnostic="${TMP}/${label}.json"
  local stdout="${TMP}/${label}.out"
  local stderr="${TMP}/${label}.err"
  if env \
    LETTA_SSH_BIN="${FAKE_SSH}" \
    LETTA_SSH_HOST=example.invalid \
    LETTA_SSH_PORT=3004 \
    LETTA_SSH_USER=since98kr \
    LETTA_BRIDGE_USER=since98kr \
    LETTA_BRIDGE_DEPLOY_DIAGNOSTIC_PATH="${diagnostic}" \
    FAKE_SSH_MODE="${mode}" \
    "$@" \
    bash "${DEPLOY}" >"${stdout}" 2>"${stderr}"; then
    echo "expected ${label} deployment to fail" >&2
    exit 1
  fi
  node - "${diagnostic}" "${expected}" <<'NODE'
const fs = require('node:fs');
const [path, expected] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
if (value.ok || value.category !== expected || value.stage !== 'ssh-preflight') process.exit(1);
if (!value.runner_user || value.remote_user !== 'since98kr' || value.bridge_user !== 'since98kr') process.exit(1);
NODE
  if grep -Eq 'PRIVATE_KEY_SENTINEL|KNOWN_HOST_SENTINEL' "${diagnostic}" "${stdout}" "${stderr}"; then
    echo "credential sentinel leaked in ${label}" >&2
    exit 1
  fi
}

run_case auth auth ssh-authentication
run_case host-key host-key ssh-host-key-verification
run_case connectivity connectivity ssh-connectivity
run_case identity identity remote-identity
run_case environment environment remote-environment
run_case target target remote-target
run_case unknown unknown ssh-preflight
run_case dedicated target remote-target \
  LETTA_SSH_PRIVATE_KEY='PRIVATE_KEY_SENTINEL' \
  LETTA_SSH_KNOWN_HOSTS='KNOWN_HOST_SENTINEL' \
  FAKE_REQUIRE_SECRET_FILES=true

node - "${TMP}/dedicated.json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.identity_source !== 'staging-environment-secret') process.exit(1);
if (value.known_hosts_source !== 'staging-environment-secret') process.exit(1);
NODE

printf '%s\n' '[letta-ssh-diagnostics-nodecheck] PASS'
