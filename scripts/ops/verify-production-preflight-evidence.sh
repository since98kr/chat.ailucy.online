#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE="${1:?Usage: verify-production-preflight-evidence.sh <artifact.zip> <expected-sha> [summary.json]}"
EXPECTED_SHA="${2:?Expected full commit SHA is required}"
SUMMARY_PATH="${3:-}"

log() {
  printf '[production-preflight-evidence] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

find_unique_file() {
  local root="$1" pattern="$2" label="$3"
  local -a matches=()
  mapfile -t matches < <(find "${root}" -type f -path "${pattern}" -print | sort)
  [[ "${#matches[@]}" -eq 1 ]] \
    || fail "expected exactly one ${label}; found ${#matches[@]}"
  printf '%s' "${matches[0]}"
}

require_command unzip
require_command node
[[ -r "${ARCHIVE}" ]] || fail "artifact ZIP is not readable: ${ARCHIVE}"
[[ "${EXPECTED_SHA}" =~ ^[0-9a-f]{40}$ ]] || fail 'expected SHA must be a full lowercase 40-character commit SHA'

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

READINESS_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-production-readiness.json' 'production readiness report')"
PREFLIGHT_FILE="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-preflight.json' 'strict preflight report')"
PREFLIGHT_LOG="$(find_unique_file "${TMP_DIR}" '*/chat-v2/production/state/last-preflight-output.log' 'preflight output log')"

mapfile -t DEPLOYMENT_FILES < <(find "${TMP_DIR}" -type f -path '*/chat-v2/production/state/last-deployment.json' -print | sort)
[[ "${#DEPLOYMENT_FILES[@]}" -le 1 ]] || fail 'artifact contains multiple deployment reports'
DEPLOYMENT_FILE="${DEPLOYMENT_FILES[0]:-}"

node - "${READINESS_FILE}" "${PREFLIGHT_FILE}" "${PREFLIGHT_LOG}" "${DEPLOYMENT_FILE}" "${EXPECTED_SHA}" "${SUMMARY_PATH}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [readinessPath, preflightPath, logPath, deploymentPath, expectedSha, summaryPath] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`[production-preflight-evidence] ERROR: ${message}\n`);
  process.exit(1);
}

function loadJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} is not a valid timestamp`);
  return timestamp;
}

const readiness = loadJson(readinessPath, 'production readiness report');
const preflight = loadJson(preflightPath, 'strict preflight report');
const preflightLog = fs.readFileSync(logPath, 'utf8');

if (readiness.ok !== true) fail('readiness.ok must be true');
if (readiness.mode !== 'preflight') fail('readiness.mode must be preflight');
if (readiness.revision !== expectedSha) fail('readiness revision does not match the expected SHA');
if (readiness.image !== `chat-ailucy-v2:production-${expectedSha}`) fail('readiness image identity is not the immutable production candidate');
if (typeof readiness.dataDir !== 'string' || !readiness.dataDir.startsWith('/opt/chat-v2/production/')) {
  fail('readiness dataDir must use the production namespace');
}
if (readiness.dataDir === '/opt/chat-v2/staging' || readiness.dataDir.startsWith('/opt/chat-v2/staging/')) {
  fail('readiness dataDir reuses the staging namespace');
}
if (!Number.isInteger(readiness.port) || readiness.port < 1024 || readiness.port > 65535) {
  fail('readiness port must be an integer between 1024 and 65535');
}
if (readiness.port === 14174) fail('readiness port reuses the staging port');
const readinessTimestamp = parseTimestamp(readiness.checkedAt, 'readiness.checkedAt');

if (preflight.ok !== true) fail('preflight.ok must be true');
if (preflight.strict !== true) fail('preflight.strict must be true');
if (!preflight.build || preflight.build.sha !== expectedSha) fail('preflight build SHA does not match the expected SHA');
if (preflight.build.environment !== 'production') fail('preflight build environment must be production');

if (!Array.isArray(preflight.checks) || preflight.checks.length === 0) fail('preflight checks are missing');
const checkNames = new Set();
for (const check of preflight.checks) {
  if (!check || typeof check.name !== 'string') fail('preflight contains an invalid check record');
  if (checkNames.has(check.name)) fail(`preflight contains a duplicate check: ${check.name}`);
  checkNames.add(check.name);
  if (check.ok !== true) fail(`preflight check failed: ${check.name}`);
}

const requiredChecks = [
  'database-directory',
  'artifact-directory',
  'backup-directory',
  'disk-free',
  'database-integrity',
  'authentication',
  'public-origin',
  'adapter-letta',
  'adapter-hermes',
];
for (const name of requiredChecks) {
  if (!checkNames.has(name)) fail(`required preflight check is missing: ${name}`);
}

for (const adapterName of ['letta', 'hermes']) {
  const adapter = preflight.adapters?.[adapterName];
  if (!adapter || adapter.ok !== true) fail(`${adapterName} adapter is not healthy`);
  if (adapter.mode !== 'http') fail(`${adapterName} adapter must use real HTTP mode`);
  if (typeof adapter.detail !== 'string' || !adapter.detail.startsWith('200')) {
    fail(`${adapterName} adapter detail does not confirm HTTP 200`);
  }
}

const completionMarker = `Production preflight passed for revision ${expectedSha}.`;
if (!preflightLog.includes(completionMarker)) fail('preflight output log is missing the exact completion marker');

let priorDeployment = null;
if (deploymentPath) {
  const deployment = loadJson(deploymentPath, 'deployment report');
  if (deployment.ok !== true) fail('deployment report exists but is not successful JSON');
  const deployedTimestamp = parseTimestamp(deployment.deployedAt, 'deployment.deployedAt');
  if (deployedTimestamp >= readinessTimestamp) {
    fail('deployment occurred at or after the preflight readiness timestamp');
  }
  priorDeployment = {
    revision: deployment.revision ?? null,
    deployedAt: deployment.deployedAt,
    relation: 'older-than-preflight',
  };
}

const summary = {
  ok: true,
  mode: 'preflight',
  revision: expectedSha,
  image: readiness.image,
  checkedAt: readiness.checkedAt,
  dataDir: readiness.dataDir,
  port: readiness.port,
  strict: true,
  checkCount: preflight.checks.length,
  adapters: {
    letta: { ok: true, mode: preflight.adapters.letta.mode, detail: preflight.adapters.letta.detail },
    hermes: { ok: true, mode: preflight.adapters.hermes.mode, detail: preflight.adapters.hermes.detail },
  },
  priorDeployment,
  sourceFiles: {
    readiness: path.basename(readinessPath),
    preflight: path.basename(preflightPath),
    preflightLog: path.basename(logPath),
    deployment: deploymentPath ? path.basename(deploymentPath) : null,
  },
};

const serialized = `${JSON.stringify(summary, null, 2)}\n`;
if (summaryPath) {
  fs.writeFileSync(summaryPath, serialized, { flag: 'wx' });
  process.stdout.write(`${summaryPath}\n`);
} else {
  process.stdout.write(serialized);
}
NODE

log "Production preflight evidence passed for ${EXPECTED_SHA}."
