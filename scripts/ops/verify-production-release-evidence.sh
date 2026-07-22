#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE="${1:?Usage: verify-production-release-evidence.sh <artifact.zip> <expected-sha> <run-id> [summary.json]}"
EXPECTED_SHA="${2:?Expected full SHA is required}"
EXPECTED_RUN_ID="${3:?Expected GitHub run ID is required}"
SUMMARY_PATH="${4:-}"

log() {
  printf '[production-release-evidence] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

find_unique_file() {
  local root="$1" pattern="$2" label="$3"
  local -a matches=()
  mapfile -t matches < <(find "${root}" -type f -path "${pattern}" -print | sort)
  [[ "${#matches[@]}" -eq 1 ]] || fail "expected exactly one ${label}; found ${#matches[@]}"
  printf '%s' "${matches[0]}"
}

command -v unzip >/dev/null || fail 'unzip is required'
command -v node >/dev/null || fail 'node is required'
[[ -r "${ARCHIVE}" ]] || fail "artifact ZIP is not readable: ${ARCHIVE}"
[[ "${EXPECTED_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail 'expected SHA must be a full lowercase 40-character SHA'
[[ "${EXPECTED_RUN_ID}" =~ ^[1-9][0-9]*$ ]] || fail 'expected run ID must be numeric'

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mapfile -t ZIP_ENTRIES < <(unzip -Z1 "${ARCHIVE}")
[[ "${#ZIP_ENTRIES[@]}" -gt 0 ]] || fail 'artifact ZIP is empty'
for entry in "${ZIP_ENTRIES[@]}"; do
  [[ -n "${entry}" ]] || fail 'artifact ZIP contains an empty path'
  [[ "${entry}" != /* ]] || fail "artifact ZIP contains an absolute path: ${entry}"
  [[ "${entry}" != *\\* ]] || fail "artifact ZIP contains a backslash path: ${entry}"
  case "/${entry}/" in
    */../*) fail "artifact ZIP contains path traversal: ${entry}" ;;
  esac
done
DUPLICATE_ENTRY="$(printf '%s\n' "${ZIP_ENTRIES[@]}" | sort | uniq -d | head -n 1)"
[[ -z "${DUPLICATE_ENTRY}" ]] || fail "artifact ZIP contains a duplicate path: ${DUPLICATE_ENTRY}"

unzip -qq "${ARCHIVE}" -d "${TMP_DIR}"
if find "${TMP_DIR}" -type l -print -quit | grep -q .; then
  fail 'artifact ZIP extracted a symbolic link'
fi

READINESS_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-production-readiness.json' 'readiness report')"
PREFLIGHT_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-preflight.json' 'strict preflight report')"
PREFLIGHT_LOG="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-preflight-output.log' 'preflight output log')"
BACKUP_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-backup.json' 'backup report')"
HEALTH_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-health.json' 'health report')"
OPS_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-ops-status.json' 'operations report')"
DEPLOYMENT_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-deployment.json' 'deployment report')"
PREREQUISITES_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2-production-evidence/rollback-prerequisites.json' 'rollback prerequisite marker')"
LOCAL_E2E_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2-production-evidence/local-e2e.json' 'local E2E marker')"
PUBLIC_E2E_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2-production-evidence/public-e2e.json' 'public E2E marker')"

mapfile -t BACKUP_VERIFY_FILES < <(find "${TMP_DIR}" -type f -path '*/chat-v2/production/state/last-backup-verify.json' -print | sort)
[[ "${#BACKUP_VERIFY_FILES[@]}" -le 1 ]] || fail 'artifact contains multiple backup verification reports'
BACKUP_VERIFY_FILE="${BACKUP_VERIFY_FILES[0]:-}"

LOCAL_REPORT_COUNT="$(find "${TMP_DIR}" -type f -path '*/playwright-staging-report/index.html' | wc -l | tr -d ' ')"
PUBLIC_REPORT_COUNT="$(find "${TMP_DIR}" -type f -path '*/playwright-external-staging-report/index.html' | wc -l | tr -d ' ')"

node - \
  "${READINESS_FILE}" "${PREFLIGHT_FILE}" "${PREFLIGHT_LOG}" "${BACKUP_FILE}" \
  "${BACKUP_VERIFY_FILE}" "${HEALTH_FILE}" "${OPS_FILE}" "${DEPLOYMENT_FILE}" \
  "${PREREQUISITES_FILE}" "${LOCAL_E2E_FILE}" "${PUBLIC_E2E_FILE}" \
  "${EXPECTED_SHA}" "${EXPECTED_RUN_ID}" "${SUMMARY_PATH}" \
  "${LOCAL_REPORT_COUNT}" "${PUBLIC_REPORT_COUNT}" <<'NODE'
const fs = require('node:fs');

const [
  readinessPath, preflightPath, preflightLogPath, backupPath, backupVerifyPath,
  healthPath, opsPath, deploymentPath, prerequisitesPath, localE2ePath, publicE2ePath,
  expectedSha, expectedRunIdRaw, summaryPath, localReportCountRaw, publicReportCountRaw,
] = process.argv.slice(2);
const expectedRunId = Number(expectedRunIdRaw);

function fail(message) {
  process.stderr.write(`[production-release-evidence] ERROR: ${message}\n`);
  process.exit(1);
}
function loadJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}
function time(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a valid timestamp`);
  return parsed;
}
function requireAdapter(adapter, label) {
  if (!adapter || adapter.ok !== true) fail(`${label} adapter is unhealthy`);
  if (adapter.mode !== 'http') fail(`${label} adapter must use real HTTP mode`);
  if (typeof adapter.detail !== 'string' || !adapter.detail.startsWith('200')) {
    fail(`${label} adapter detail does not confirm HTTP 200`);
  }
}
function requireChecks(marker, phase, required) {
  if (marker.ok !== true || marker.phase !== phase) fail(`${phase} E2E marker is invalid`);
  if (marker.revision !== expectedSha) fail(`${phase} E2E revision mismatch`);
  if (marker.runId !== expectedRunId) fail(`${phase} E2E run ID mismatch`);
  if (!Array.isArray(marker.checks)) fail(`${phase} E2E checks are missing`);
  const names = new Set(marker.checks);
  for (const name of required) if (!names.has(name)) fail(`${phase} E2E check is missing: ${name}`);
}

const readiness = loadJson(readinessPath, 'readiness report');
const preflight = loadJson(preflightPath, 'strict preflight report');
const preflightLog = fs.readFileSync(preflightLogPath, 'utf8');
const backup = loadJson(backupPath, 'backup report');
const health = loadJson(healthPath, 'health report');
const ops = loadJson(opsPath, 'operations report');
const deployment = loadJson(deploymentPath, 'deployment report');
const prerequisites = loadJson(prerequisitesPath, 'rollback prerequisite marker');
const localE2e = loadJson(localE2ePath, 'local E2E marker');
const publicE2e = loadJson(publicE2ePath, 'public E2E marker');

if (readiness.ok !== true || readiness.mode !== 'preflight') fail('readiness report is not a successful strict preflight');
if (readiness.revision !== expectedSha) fail('readiness revision mismatch');
if (readiness.image !== `chat-ailucy-v2:production-${expectedSha}`) fail('readiness image mismatch');
if (typeof readiness.dataDir !== 'string' || !readiness.dataDir.startsWith('/opt/chat-v2/production/')) fail('readiness data directory is outside production');
if (!Number.isInteger(readiness.port) || readiness.port < 1024 || readiness.port > 65535 || readiness.port === 14174) fail('readiness port is invalid or reuses staging');

if (preflight.ok !== true || preflight.strict !== true) fail('strict preflight did not pass');
if (preflight.build?.sha !== expectedSha || preflight.build?.environment !== 'production') fail('preflight build identity mismatch');
if (!Array.isArray(preflight.checks) || preflight.checks.length === 0) fail('preflight checks are missing');
const checkNames = new Set();
for (const check of preflight.checks) {
  if (!check || typeof check.name !== 'string' || check.ok !== true) fail('preflight contains a failed or malformed check');
  if (checkNames.has(check.name)) fail(`duplicate preflight check: ${check.name}`);
  checkNames.add(check.name);
}
for (const name of ['database-directory','artifact-directory','backup-directory','disk-free','database-integrity','authentication','public-origin','adapter-letta','adapter-hermes']) {
  if (!checkNames.has(name)) fail(`required preflight check is missing: ${name}`);
}
requireAdapter(preflight.adapters?.letta, 'preflight Letta');
requireAdapter(preflight.adapters?.hermes, 'preflight Hermes');
if (!preflightLog.includes(`Production preflight passed for revision ${expectedSha}.`)) fail('preflight completion marker is missing');

if (prerequisites.ok !== true || prerequisites.revision !== expectedSha) fail('rollback prerequisite marker mismatch');
if (!['standard', 'initial'].includes(prerequisites.mode)) fail('rollback prerequisite mode is invalid');
if (prerequisites.deployRoot !== '/opt/chat-v2/production' && !prerequisites.deployRoot.startsWith('/opt/chat-v2/production/')) fail('rollback prerequisite root is outside production');
if (prerequisites.dataDir !== '/opt/chat-v2/production/data' && !prerequisites.dataDir.startsWith('/opt/chat-v2/production/')) fail('rollback prerequisite data directory is outside production');

if (deployment.ok !== true || deployment.environment !== 'production') fail('deployment report is not a successful production deployment');
if (deployment.revision !== expectedSha) fail('deployment revision mismatch');
if (deployment.image !== `chat-ailucy-v2:production-${expectedSha}`) fail('deployment image mismatch');

const prereqTime = time(prerequisites.checkedAt, 'prerequisites.checkedAt');
const readinessTime = time(readiness.checkedAt, 'readiness.checkedAt');
const healthTime = time(health.timestamp, 'health.timestamp');
const opsTime = time(ops.timestamp, 'ops.timestamp');
const deploymentTime = time(deployment.deployedAt, 'deployment.deployedAt');
const localTime = time(localE2e.checkedAt, 'localE2e.checkedAt');
const publicTime = time(publicE2e.checkedAt, 'publicE2e.checkedAt');
if (!(prereqTime <= readinessTime && readinessTime <= healthTime && healthTime <= deploymentTime && opsTime <= deploymentTime && deploymentTime <= localTime && localTime <= publicTime)) {
  fail('release evidence timestamps are out of order');
}

if (health.ok !== true) fail('health report is not ok');
requireAdapter(health.adapters?.letta, 'health Letta');
requireAdapter(health.adapters?.hermes, 'health Hermes');
if (ops.ok !== true || ops.build?.sha !== expectedSha || ops.build?.environment !== 'production') fail('operations build identity mismatch');
if (!['cloudflare', 'token'].includes(ops.auth?.mode)) fail('operations authentication mode is invalid');
requireAdapter(ops.adapters?.letta, 'operations Letta');
requireAdapter(ops.adapters?.hermes, 'operations Hermes');

if (prerequisites.mode === 'standard') {
  if (prerequisites.databasePresent !== true) fail('standard release requires a production database');
  if (typeof prerequisites.previousImage !== 'string' || !prerequisites.previousImage.startsWith('chat-ailucy-v2:')) fail('standard release requires a prior Chat V2 image');
  if (deployment.previousImage !== prerequisites.previousImage) fail('deployment rollback image does not match prerequisites');
  if (typeof backup.id !== 'string' || !backup.id) fail('standard release backup ID is missing');
  if (deployment.backupId !== backup.id) fail('deployment backup ID mismatch');
  if (!backup.manifest || !/^[0-9a-f]{64}$/.test(backup.manifest.database?.sha256 || '')) fail('backup database checksum is invalid');
  if (!backupVerifyPath) fail('standard release backup verification report is missing');
  const backupVerify = loadJson(backupVerifyPath, 'backup verification report');
  if (backupVerify.ok !== true || !Array.isArray(backupVerify.errors) || backupVerify.errors.length !== 0) fail('backup verification did not pass');
  if (backupVerify.manifest?.database?.sha256 !== backup.manifest.database.sha256) fail('backup verification checksum mismatch');
} else {
  if (prerequisites.databasePresent !== false || prerequisites.previousImage !== null) fail('initial release prerequisites are inconsistent');
  if (deployment.previousImage !== null || deployment.backupId !== null) fail('initial release deployment unexpectedly records rollback or backup state');
  if (backup.skipped !== true || backup.reason !== 'database-not-created') fail('initial release backup skip evidence is invalid');
  if (backupVerifyPath) fail('initial release artifact must not contain a stale backup verification report');
}

requireChecks(localE2e, 'local', ['transport','browser','artifact-roundtrip','multimodal','generated-artifact']);
requireChecks(publicE2e, 'public', ['cloudflare-access','browser','artifact-roundtrip','multimodal','generated-artifact']);
if (localE2e.endpoint !== `http://127.0.0.1:${readiness.port}`) fail('local E2E endpoint does not match the production port');
if (typeof publicE2e.endpoint !== 'string' || !publicE2e.endpoint.startsWith('https://')) fail('public E2E endpoint must use https');

const summary = {
  ok: true,
  mode: 'deploy',
  releaseMode: prerequisites.mode,
  revision: expectedSha,
  runId: expectedRunId,
  image: deployment.image,
  previousImage: deployment.previousImage,
  backupId: deployment.backupId,
  deployedAt: deployment.deployedAt,
  localE2E: { endpoint: localE2e.endpoint, checkedAt: localE2e.checkedAt },
  publicE2E: { endpoint: publicE2e.endpoint, checkedAt: publicE2e.checkedAt },
  adapters: {
    letta: { ok: true, mode: ops.adapters.letta.mode, detail: ops.adapters.letta.detail },
    hermes: { ok: true, mode: ops.adapters.hermes.mode, detail: ops.adapters.hermes.detail },
  },
  reports: {
    localPlaywright: Number(localReportCountRaw),
    publicPlaywright: Number(publicReportCountRaw),
  },
};
const serialized = `${JSON.stringify(summary, null, 2)}\n`;
if (summaryPath) fs.writeFileSync(summaryPath, serialized, { flag: 'wx' });
else process.stdout.write(serialized);
NODE

log "Production release evidence passed for ${EXPECTED_SHA} (run ${EXPECTED_RUN_ID})."
