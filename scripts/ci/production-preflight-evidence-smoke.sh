#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="${REPO_ROOT}/scripts/ops/verify-production-preflight-evidence.sh"
EXPECTED_SHA='9a787035ec65e6e9973222b99cb427c64d108f4b'
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

make_fixture() {
  local root="$1" deployment_time="$2" hermes_ok="$3" revision="$4"
  local state="${root}/chat-v2/production/state"
  mkdir -p "${state}"

  cat >"${state}/last-production-readiness.json" <<JSON
{
  "ok": true,
  "mode": "preflight",
  "revision": "${revision}",
  "image": "chat-ailucy-v2:production-${revision}",
  "dataDir": "/opt/chat-v2/production/data",
  "port": 15174,
  "checkedAt": "2026-07-22T22:00:00.000Z"
}
JSON

  cat >"${state}/last-preflight.json" <<JSON
{
  "ok": true,
  "strict": true,
  "generatedAt": "2026-07-22T21:59:59.000Z",
  "build": {
    "service": "chat-ailucy-v2",
    "version": "0.8.0",
    "sha": "${revision}",
    "builtAt": "2026-07-22T21:50:00.000Z",
    "environment": "production"
  },
  "checks": [
    {"name":"database-directory","ok":true,"level":"info","detail":"/data is writable"},
    {"name":"artifact-directory","ok":true,"level":"info","detail":"/data/artifacts is writable"},
    {"name":"backup-directory","ok":true,"level":"info","detail":"/data/backups is writable"},
    {"name":"disk-free","ok":true,"level":"info","detail":"4096 MiB free"},
    {"name":"database-integrity","ok":true,"level":"info","detail":"quick_check=ok"},
    {"name":"authentication","ok":true,"level":"info","detail":"mode=cloudflare"},
    {"name":"public-origin","ok":true,"level":"info","detail":"https://chat.example.invalid"},
    {"name":"adapter-letta","ok":true,"level":"info","detail":"mode=http; 200 OK"},
    {"name":"adapter-hermes","ok":${hermes_ok},"level":"info","detail":"mode=http; 200 OK"}
  ],
  "adapters": {
    "letta": {"ok":true,"mode":"http","detail":"200 OK","latencyMs":10},
    "hermes": {"ok":${hermes_ok},"mode":"http","detail":"200 OK","latencyMs":12}
  }
}
JSON

  printf '[chat-v2-production-preflight] Production preflight passed for revision %s.\n' "${revision}" \
    >"${state}/last-preflight-output.log"

  if [[ -n "${deployment_time}" ]]; then
    cat >"${state}/last-deployment.json" <<JSON
{
  "ok": true,
  "environment": "production",
  "revision": "1111111111111111111111111111111111111111",
  "deployedAt": "${deployment_time}"
}
JSON
  fi
}

zip_fixture() {
  local root="$1" archive="$2"
  (cd "${root}" && zip -qr "${archive}" chat-v2)
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${TMP_DIR}/${label}.out" 2>"${TMP_DIR}/${label}.err"; then
    printf 'expected verification failure but command passed: %s\n' "${label}" >&2
    exit 1
  fi
}

VALID_ROOT="${TMP_DIR}/valid"
make_fixture "${VALID_ROOT}" '2026-07-21T22:00:00.000Z' true "${EXPECTED_SHA}"
zip_fixture "${VALID_ROOT}" "${TMP_DIR}/valid.zip"
bash "${VERIFIER}" "${TMP_DIR}/valid.zip" "${EXPECTED_SHA}" >"${TMP_DIR}/valid-summary.json"
node -e '
  const fs = require("node:fs");
  const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!summary.ok || summary.mode !== "preflight") process.exit(1);
  if (summary.revision !== process.argv[2]) process.exit(1);
  if (summary.adapters.letta.mode !== "http" || summary.adapters.hermes.mode !== "http") process.exit(1);
  if (summary.priorDeployment?.relation !== "older-than-preflight") process.exit(1);
' "${TMP_DIR}/valid-summary.json" "${EXPECTED_SHA}"

expect_failure wrong-sha bash "${VERIFIER}" "${TMP_DIR}/valid.zip" \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

RECENT_DEPLOY_ROOT="${TMP_DIR}/recent-deploy"
make_fixture "${RECENT_DEPLOY_ROOT}" '2026-07-22T22:00:01.000Z' true "${EXPECTED_SHA}"
zip_fixture "${RECENT_DEPLOY_ROOT}" "${TMP_DIR}/recent-deploy.zip"
expect_failure recent-deployment bash "${VERIFIER}" "${TMP_DIR}/recent-deploy.zip" "${EXPECTED_SHA}"

UNHEALTHY_ROOT="${TMP_DIR}/unhealthy"
make_fixture "${UNHEALTHY_ROOT}" '' false "${EXPECTED_SHA}"
zip_fixture "${UNHEALTHY_ROOT}" "${TMP_DIR}/unhealthy.zip"
expect_failure unhealthy-hermes bash "${VERIFIER}" "${TMP_DIR}/unhealthy.zip" "${EXPECTED_SHA}"

python3 - "${TMP_DIR}/traversal.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    archive.writestr('../escape.json', '{}')
PY
expect_failure traversal bash "${VERIFIER}" "${TMP_DIR}/traversal.zip" "${EXPECTED_SHA}"

MISSING_LOG_ROOT="${TMP_DIR}/missing-log"
make_fixture "${MISSING_LOG_ROOT}" '' true "${EXPECTED_SHA}"
rm -f "${MISSING_LOG_ROOT}/chat-v2/production/state/last-preflight-output.log"
zip_fixture "${MISSING_LOG_ROOT}" "${TMP_DIR}/missing-log.zip"
expect_failure missing-log bash "${VERIFIER}" "${TMP_DIR}/missing-log.zip" "${EXPECTED_SHA}"

printf '%s\n' '[production-preflight-evidence-smoke] PASS'
