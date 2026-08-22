#!/usr/bin/env bash
# Focused check for scripts/ops/staging-qa-gate-guard.sh.
#
# Runs the guard in a clean environment (env -i) for accepted and rejected
# combinations. Requires neither Docker, nor a network, nor a built image.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="${HERE}/staging-qa-gate-guard.sh"
LABEL='[staging-qa-gate-guard-nodecheck]'

test -r "${GUARD}" || {
  printf '%s FAIL: guard not found at %s\n' "${LABEL}" "${GUARD}" >&2
  exit 1
}

FAILURES=0
CHECKS=0

# run_guard <command> [NAME=VALUE ...]
run_guard() {
  local command="$1"
  shift
  env -i "PATH=${PATH}" "$@" bash "${GUARD}" "${command}"
}

# expect_pass <description> <command> [NAME=VALUE ...]
expect_pass() {
  local description="$1"
  shift
  local output status
  CHECKS=$((CHECKS + 1))

  set +e
  output="$(run_guard "$@" 2>&1)"
  status=$?
  set -e

  if [[ "${status}" -eq 0 ]]; then
    printf '%s ok   accepted: %s\n' "${LABEL}" "${description}"
  else
    FAILURES=$((FAILURES + 1))
    printf '%s FAIL expected acceptance but exit=%s: %s\n' "${LABEL}" "${status}" "${description}" >&2
    printf '%s      output: %s\n' "${LABEL}" "${output}" >&2
  fi
}

# expect_fail <description> <expected-substring> <command> [NAME=VALUE ...]
expect_fail() {
  local description="$1"
  local expected="$2"
  shift 2
  local output status
  CHECKS=$((CHECKS + 1))

  set +e
  output="$(run_guard "$@" 2>&1)"
  status=$?
  set -e

  if [[ "${status}" -eq 0 ]]; then
    FAILURES=$((FAILURES + 1))
    printf '%s FAIL expected rejection but the guard accepted: %s\n' "${LABEL}" "${description}" >&2
    return
  fi

  if [[ "${output}" != *"${expected}"* ]]; then
    FAILURES=$((FAILURES + 1))
    printf '%s FAIL rejected but the message did not mention %s: %s\n' "${LABEL}" "${expected}" "${description}" >&2
    printf '%s      output: %s\n' "${LABEL}" "${output}" >&2
    return
  fi

  printf '%s ok   rejected: %s\n' "${LABEL}" "${description}"
}

ALL_FALSE=(
  CHAT_MULTIMODAL_QA_REQUIRED=false
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false
  CHAT_EXTERNAL_QA_REQUIRED=false
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false
)

ARTIFACT_CONTRACT=(
  HERMES_PROTOCOL=openai
  HERMES_ARTIFACT_TOOL_ENABLED=true
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true
)

# ---------------------------------------------------------------------------
# Accepted combinations
# ---------------------------------------------------------------------------

expect_pass 'all four gates explicitly false' \
  enforce-all "${ALL_FALSE[@]}"

expect_pass 'deferred gates false, enabled gates true, artifact contract satisfied' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  "${ARTIFACT_CONTRACT[@]}"

expect_pass 'all four gates explicitly true with artifact contract satisfied' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=true \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=true \
  "${ARTIFACT_CONTRACT[@]}"

expect_pass 'artifact gate disabled leaves the Hermes contract unchecked' \
  enforce-all "${ALL_FALSE[@]}" HERMES_PROTOCOL=openclaw

expect_pass 'artifact contract command alone is a no-op while the gate is false' \
  enforce-artifact-contract CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false

# ---------------------------------------------------------------------------
# Rejected combinations: variable shape
# ---------------------------------------------------------------------------

expect_fail 'every gate variable undefined' \
  'CHAT_MULTIMODAL_QA_REQUIRED is not defined' \
  enforce-all

expect_fail 'one gate variable undefined' \
  'CHAT_EXTERNAL_QA_REQUIRED is not defined' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect_fail 'gate variable defined but empty' \
  'CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED is defined but empty' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=

for bad_value in TRUE True FALSE Yes yes no on off 1 0 ' true' 'true ' 'true#comment'; do
  expect_fail "uppercase or non-canonical value '${bad_value}'" \
    "must be exactly 'true' or 'false'" \
    enforce-all \
    "CHAT_MULTIMODAL_QA_REQUIRED=${bad_value}" \
    CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
    CHAT_EXTERNAL_QA_REQUIRED=false \
    CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false
done

expect_fail 'validate-vars alone still rejects an unset gate' \
  'is not defined' \
  validate-vars \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false

# ---------------------------------------------------------------------------
# Rejected combinations: generated artifact contract
# ---------------------------------------------------------------------------

expect_fail 'artifact gate true with no Hermes artifact configuration at all' \
  'HERMES_PROTOCOL is not defined' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect_fail 'artifact gate true with the wrong Hermes protocol' \
  "requires HERMES_PROTOCOL=openai, received 'openclaw'" \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openclaw \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect_fail 'artifact gate true with the artifact tool disabled' \
  "requires HERMES_ARTIFACT_TOOL_ENABLED=true, received 'false'" \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=false \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect_fail 'artifact gate true with the artifact envelope missing' \
  'HERMES_ARTIFACT_ENVELOPE_ENABLED is not defined' \
  enforce-all \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=true

expect_fail 'artifact contract command alone rejects a violated contract' \
  'Refusing to start the staging runtime container' \
  enforce-artifact-contract \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=false

expect_fail 'unknown command' \
  'unknown command' \
  totally-unknown-command "${ALL_FALSE[@]}"

# ---------------------------------------------------------------------------

if [[ "${FAILURES}" -ne 0 ]]; then
  printf '%s FAIL %s of %s checks failed\n' "${LABEL}" "${FAILURES}" "${CHECKS}" >&2
  exit 1
fi

printf '%s PASS %s checks\n' "${LABEL}" "${CHECKS}"
