#!/usr/bin/env bash
set -Eeuo pipefail

PHASE="${1:?Usage: write-production-e2e-marker.sh <local|public> <full-sha> <run-id> <output-json>}"
REVISION="${2:?Full revision is required}"
RUN_ID="${3:?GitHub run ID is required}"
OUTPUT="${4:?Output JSON path is required}"

fail() {
  printf '[production-e2e-marker] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${PHASE}" == 'local' || "${PHASE}" == 'public' ]] || fail 'phase must be local or public'
[[ "${REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be a full lowercase 40-character SHA'
[[ "${RUN_ID}" =~ ^[1-9][0-9]*$ ]] || fail 'run ID must be numeric'
[[ ! -e "${OUTPUT}" ]] || fail "output already exists: ${OUTPUT}"
mkdir -p "$(dirname "${OUTPUT}")"

if [[ "${PHASE}" == 'local' ]]; then
  ENDPOINT="http://127.0.0.1:${CHAT_PRODUCTION_PORT:?CHAT_PRODUCTION_PORT is required}"
  CHECKS='["transport","browser","artifact-roundtrip","multimodal","generated-artifact"]'
else
  ENDPOINT="${CHAT_PUBLIC_ORIGIN:?CHAT_PUBLIC_ORIGIN is required}"
  [[ "${ENDPOINT}" == https://* ]] || fail 'public production origin must use https'
  CHECKS='["cloudflare-access","browser","artifact-roundtrip","multimodal","generated-artifact"]'
fi

PHASE="${PHASE}" REVISION="${REVISION}" RUN_ID="${RUN_ID}" ENDPOINT="${ENDPOINT}" \
CHECKS="${CHECKS}" node - "${OUTPUT}" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
fs.writeFileSync(output, JSON.stringify({
  ok: true,
  phase: process.env.PHASE,
  revision: process.env.REVISION,
  runId: Number(process.env.RUN_ID),
  endpoint: process.env.ENDPOINT,
  checks: JSON.parse(process.env.CHECKS),
  checkedAt: new Date().toISOString(),
}, null, 2) + '\n', { flag: 'wx' });
NODE

printf '[production-e2e-marker] %s evidence recorded for %s.\n' "${PHASE}" "${REVISION}"
