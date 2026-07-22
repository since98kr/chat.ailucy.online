#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="${REPO_ROOT}/scripts/ops/verify-production-release-evidence.sh"
PREREQUISITES="${REPO_ROOT}/scripts/ops/production-deploy-prerequisites.sh"
MARKER="${REPO_ROOT}/scripts/ops/write-production-e2e-marker.sh"
SHA='9a787035ec65e6e9973222b99cb427c64d108f4b'
RUN_ID='424242'
TMP_DIR="$(mktemp -d)"
STANDARD_ROOT="/opt/chat-v2/production-ci-standard-${GITHUB_RUN_ID:-$$}"
INITIAL_ROOT="/opt/chat-v2/production-ci-initial-${GITHUB_RUN_ID:-$$}"

cleanup() {
  rm -rf "${TMP_DIR}"
  sudo rm -rf "${STANDARD_ROOT}" "${INITIAL_ROOT}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${TMP_DIR}/${label}.out" 2>"${TMP_DIR}/${label}.err"; then
    echo "expected failure but command passed: ${label}" >&2
    exit 1
  fi
}

make_state() {
  local root="$1" mode="$2"
  local state="${root}/chat-v2/production/state"
  local evidence="${root}/runner/_temp/chat-v2-production-evidence"
  mkdir -p "${state}" "${evidence}"

  cat >"${state}/last-production-readiness.json" <<JSON
{"ok":true,"mode":"preflight","revision":"${SHA}","image":"chat-ailucy-v2:production-${SHA}","dataDir":"/opt/chat-v2/production/data","port":15174,"checkedAt":"2026-07-22T22:00:01.000Z"}
JSON
  cat >"${state}/last-preflight.json" <<JSON
{
  "ok":true,"strict":true,
  "build":{"sha":"${SHA}","environment":"production"},
  "checks":[
    {"name":"database-directory","ok":true},{"name":"artifact-directory","ok":true},
    {"name":"backup-directory","ok":true},{"name":"disk-free","ok":true},
    {"name":"database-integrity","ok":true},{"name":"authentication","ok":true},
    {"name":"public-origin","ok":true},{"name":"adapter-letta","ok":true},
    {"name":"adapter-hermes","ok":true}
  ],
  "adapters":{"letta":{"ok":true,"mode":"http","detail":"200 OK"},"hermes":{"ok":true,"mode":"http","detail":"200 OK"}}
}
JSON
  printf 'Production preflight passed for revision %s.\n' "${SHA}" >"${state}/last-preflight-output.log"
  cat >"${state}/last-health.json" <<JSON
{"ok":true,"adapters":{"letta":{"ok":true,"mode":"http","detail":"200 OK"},"hermes":{"ok":true,"mode":"http","detail":"200 OK"}},"timestamp":"2026-07-22T22:00:02.000Z"}
JSON
  cat >"${state}/last-ops-status.json" <<JSON
{"ok":true,"build":{"sha":"${SHA}","environment":"production"},"auth":{"mode":"cloudflare"},"adapters":{"letta":{"ok":true,"mode":"http","detail":"200 OK"},"hermes":{"ok":true,"mode":"http","detail":"200 OK"}},"timestamp":"2026-07-22T22:00:02.500Z"}
JSON

  if [[ "${mode}" == 'standard' ]]; then
    cat >"${evidence}/rollback-prerequisites.json" <<JSON
{"ok":true,"mode":"standard","revision":"${SHA}","previousImage":"chat-ailucy-v2:previous","databasePresent":true,"deployRoot":"/opt/chat-v2/production","dataDir":"/opt/chat-v2/production/data","checkedAt":"2026-07-22T22:00:00.000Z"}
JSON
    cat >"${state}/last-backup.json" <<'JSON'
{"id":"backup-1","manifest":{"database":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"artifactCount":1,"artifactBytes":5}}
JSON
    cat >"${state}/last-backup-verify.json" <<'JSON'
{"ok":true,"errors":[],"manifest":{"database":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"artifactCount":1,"artifactBytes":5}}
JSON
    cat >"${state}/last-deployment.json" <<JSON
{"ok":true,"environment":"production","revision":"${SHA}","image":"chat-ailucy-v2:production-${SHA}","previousImage":"chat-ailucy-v2:previous","backupId":"backup-1","deployedAt":"2026-07-22T22:00:03.000Z"}
JSON
  else
    cat >"${evidence}/rollback-prerequisites.json" <<JSON
{"ok":true,"mode":"initial","revision":"${SHA}","previousImage":null,"databasePresent":false,"deployRoot":"/opt/chat-v2/production","dataDir":"/opt/chat-v2/production/data","checkedAt":"2026-07-22T22:00:00.000Z"}
JSON
    printf '%s\n' '{"skipped":true,"reason":"database-not-created"}' >"${state}/last-backup.json"
    cat >"${state}/last-deployment.json" <<JSON
{"ok":true,"environment":"production","revision":"${SHA}","image":"chat-ailucy-v2:production-${SHA}","previousImage":null,"backupId":null,"deployedAt":"2026-07-22T22:00:03.000Z"}
JSON
  fi

  cat >"${evidence}/local-e2e.json" <<JSON
{"ok":true,"phase":"local","revision":"${SHA}","runId":${RUN_ID},"endpoint":"http://127.0.0.1:15174","checks":["transport","browser","artifact-roundtrip","multimodal","generated-artifact"],"checkedAt":"2026-07-22T22:00:04.000Z"}
JSON
  cat >"${evidence}/public-e2e.json" <<JSON
{"ok":true,"phase":"public","revision":"${SHA}","runId":${RUN_ID},"endpoint":"https://chat.example.invalid","checks":["cloudflare-access","browser","artifact-roundtrip","multimodal","generated-artifact"],"checkedAt":"2026-07-22T22:00:05.000Z"}
JSON
  mkdir -p "${root}/runner/work/playwright-staging-report"
  printf '<html>local</html>\n' >"${root}/runner/work/playwright-staging-report/index.html"
}

zip_fixture() {
  local root="$1" zip_path="$2"
  (cd "${root}" && zip -qr "${zip_path}" .)
}

STANDARD="${TMP_DIR}/standard"
make_state "${STANDARD}" standard
zip_fixture "${STANDARD}" "${TMP_DIR}/standard.zip"
bash "${VERIFIER}" "${TMP_DIR}/standard.zip" "${SHA}" "${RUN_ID}" >"${TMP_DIR}/standard-summary.json"
node -e 'const j=require(process.argv[1]);if(!j.ok||j.releaseMode!=="standard"||j.backupId!=="backup-1")process.exit(1)' "${TMP_DIR}/standard-summary.json"

INITIAL="${TMP_DIR}/initial"
make_state "${INITIAL}" initial
zip_fixture "${INITIAL}" "${TMP_DIR}/initial.zip"
bash "${VERIFIER}" "${TMP_DIR}/initial.zip" "${SHA}" "${RUN_ID}" >"${TMP_DIR}/initial-summary.json"
node -e 'const j=require(process.argv[1]);if(!j.ok||j.releaseMode!=="initial"||j.backupId!==null)process.exit(1)' "${TMP_DIR}/initial-summary.json"

expect_failure wrong-run bash "${VERIFIER}" "${TMP_DIR}/standard.zip" "${SHA}" 999

ROLLBACK_BAD="${TMP_DIR}/rollback-bad"
cp -a "${STANDARD}" "${ROLLBACK_BAD}"
node -e 'const fs=require("fs");const p=process.argv[1];const j=require(p);j.previousImage="chat-ailucy-v2:other";fs.writeFileSync(p,JSON.stringify(j))' \
  "${ROLLBACK_BAD}/chat-v2/production/state/last-deployment.json"
zip_fixture "${ROLLBACK_BAD}" "${TMP_DIR}/rollback-bad.zip"
expect_failure rollback-mismatch bash "${VERIFIER}" "${TMP_DIR}/rollback-bad.zip" "${SHA}" "${RUN_ID}"

BACKUP_BAD="${TMP_DIR}/backup-bad"
cp -a "${STANDARD}" "${BACKUP_BAD}"
printf '%s\n' '{"ok":false,"errors":["checksum"],"manifest":{"database":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}' \
  >"${BACKUP_BAD}/chat-v2/production/state/last-backup-verify.json"
zip_fixture "${BACKUP_BAD}" "${TMP_DIR}/backup-bad.zip"
expect_failure backup-failure bash "${VERIFIER}" "${TMP_DIR}/backup-bad.zip" "${SHA}" "${RUN_ID}"

MISSING_PUBLIC="${TMP_DIR}/missing-public"
cp -a "${STANDARD}" "${MISSING_PUBLIC}"
rm -f "${MISSING_PUBLIC}/runner/_temp/chat-v2-production-evidence/public-e2e.json"
zip_fixture "${MISSING_PUBLIC}" "${TMP_DIR}/missing-public.zip"
expect_failure missing-public bash "${VERIFIER}" "${TMP_DIR}/missing-public.zip" "${SHA}" "${RUN_ID}"

TIME_BAD="${TMP_DIR}/time-bad"
cp -a "${STANDARD}" "${TIME_BAD}"
node -e 'const fs=require("fs");const p=process.argv[1];const j=require(p);j.checkedAt="2026-07-22T21:59:00.000Z";fs.writeFileSync(p,JSON.stringify(j))' \
  "${TIME_BAD}/runner/_temp/chat-v2-production-evidence/public-e2e.json"
zip_fixture "${TIME_BAD}" "${TMP_DIR}/time-bad.zip"
expect_failure time-order bash "${VERIFIER}" "${TMP_DIR}/time-bad.zip" "${SHA}" "${RUN_ID}"

INITIAL_STALE="${TMP_DIR}/initial-stale"
cp -a "${INITIAL}" "${INITIAL_STALE}"
printf '%s\n' '{"ok":true,"errors":[]}' >"${INITIAL_STALE}/chat-v2/production/state/last-backup-verify.json"
zip_fixture "${INITIAL_STALE}" "${TMP_DIR}/initial-stale.zip"
expect_failure initial-stale bash "${VERIFIER}" "${TMP_DIR}/initial-stale.zip" "${SHA}" "${RUN_ID}"

FAKE_BIN="${TMP_DIR}/bin"
mkdir -p "${FAKE_BIN}"
cat >"${FAKE_BIN}/docker" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == image && "${2:-}" == inspect && "${3:-}" == chat-ailucy-v2:previous ]]
SH
chmod +x "${FAKE_BIN}/docker"

sudo install -d -o "$(id -u)" -g "$(id -g)" "${STANDARD_ROOT}/state" "${STANDARD_ROOT}/data"
printf '%s' 'chat-ailucy-v2:previous' >"${STANDARD_ROOT}/state/current-image"
printf 'sqlite' >"${STANDARD_ROOT}/data/chat-v2.sqlite"
PATH="${FAKE_BIN}:${PATH}" CHAT_PRODUCTION_ROOT="${STANDARD_ROOT}" CHAT_PRODUCTION_DATA_DIR="${STANDARD_ROOT}/data" \
  bash "${PREREQUISITES}" "${SHA}" "${TMP_DIR}/standard-prereq.json"
node -e 'const j=require(process.argv[1]);if(j.mode!=="standard"||!j.databasePresent)process.exit(1)' "${TMP_DIR}/standard-prereq.json"

sudo install -d -o "$(id -u)" -g "$(id -g)" "${INITIAL_ROOT}"
CHAT_PRODUCTION_ROOT="${INITIAL_ROOT}" CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE=true \
CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA="${SHA}" \
  bash "${PREREQUISITES}" "${SHA}" "${TMP_DIR}/initial-prereq.json"
node -e 'const j=require(process.argv[1]);if(j.mode!=="initial"||j.databasePresent)process.exit(1)' "${TMP_DIR}/initial-prereq.json"
mkdir -p "${INITIAL_ROOT}/state"
printf '%s\n' '{"ok":true}' >"${INITIAL_ROOT}/state/last-deployment.json"
expect_failure initial-stale-prereq env CHAT_PRODUCTION_ROOT="${INITIAL_ROOT}" \
  CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE=true CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA="${SHA}" \
  bash "${PREREQUISITES}" "${SHA}" "${TMP_DIR}/initial-prereq-2.json"

CHAT_PRODUCTION_PORT=15174 bash "${MARKER}" local "${SHA}" "${RUN_ID}" "${TMP_DIR}/local-marker.json"
CHAT_PUBLIC_ORIGIN=https://chat.example.invalid bash "${MARKER}" public "${SHA}" "${RUN_ID}" "${TMP_DIR}/public-marker.json"
node -e 'const j=require(process.argv[1]);if(j.phase!=="public"||j.runId!==424242)process.exit(1)' "${TMP_DIR}/public-marker.json"

printf '%s\n' '[production-release-evidence-smoke] PASS'
