#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANITIZER="${ROOT}/sanitize-staging-smoke-log.py"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

cat >"${TMP}/raw.log" <<'LOG'
[chat-v2-smoke] Calling letta through Chat V2.
Authorization: Bearer super-secret-token
Cf-Access-Authenticated-User-Email: operator@example.com
LETTA_API_KEY=sk-example-secret-value
GitHub token gho_abcdefghijklmnopqrstuvwxyz
adapter run failed: command at /home/since98kr/.nvm/versions/node/v22/bin/node
expected marker not found: CHAT_V2_LETTA_OK; response='wrong response'
LOG

python3 "${SANITIZER}" "${TMP}/raw.log" "${TMP}/safe/smoke.log"

grep -Fq '[chat-v2-smoke] Calling letta through Chat V2.' "${TMP}/safe/smoke.log"
grep -Fq 'expected marker not found: CHAT_V2_LETTA_OK' "${TMP}/safe/smoke.log"
grep -Fq '<redacted-email>' "${TMP}/safe/smoke.log"
grep -Fq '<redacted-github-token>' "${TMP}/safe/smoke.log"
grep -Fq '<redacted-path>' "${TMP}/safe/smoke.log"
if grep -Eq 'super-secret-token|operator@example.com|sk-example-secret-value|gho_abcdefghijklmnopqrstuvwxyz|/home/since98kr' "${TMP}/safe/smoke.log"; then
  echo 'sanitized smoke log retained sensitive material' >&2
  exit 1
fi
[[ "$(stat -c '%a' "${TMP}/safe/smoke.log")" == '600' ]]
[[ "$(stat -c '%a' "${TMP}/safe")" == '700' ]]

printf '%s\n' '[sanitize-staging-smoke-log-nodecheck] PASS'
