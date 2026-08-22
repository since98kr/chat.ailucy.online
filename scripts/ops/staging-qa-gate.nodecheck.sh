#!/usr/bin/env bash
# Combination tests for scripts/ops/staging-qa-gate.sh.
# No Docker, no network, no container runtime is required.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${SCRIPT_DIR}/staging-qa-gate.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

FAILURES=0
CASES=0

run_gate() {
  # usage: run_gate NAME=VALUE ...
  env -i "PATH=${PATH}" "HOME=${TMP_DIR}" "$@" bash "${GATE}" >"${TMP_DIR}/out.log" 2>&1
}

expect() {
  local expected_status="$1"
  local description="$2"
  local expected_text="$3"
  shift 3

  CASES=$((CASES + 1))
  local status=0
  run_gate "$@" || status=$?

  if [[ "${status}" -ne "${expected_status}" ]]; then
    printf 'FAIL: %s (expected exit %s, got %s)\n' "${description}" "${expected_status}" "${status}"
    cat "${TMP_DIR}/out.log"
    FAILURES=$((FAILURES + 1))
    return
  fi

  if [[ -n "${expected_text}" ]] && ! grep -qF "${expected_text}" "${TMP_DIR}/out.log"; then
    printf 'FAIL: %s (output did not contain: %s)\n' "${description}" "${expected_text}"
    cat "${TMP_DIR}/out.log"
    FAILURES=$((FAILURES + 1))
    return
  fi

  printf 'ok - %s\n' "${description}"
}

ALL_FALSE=(
  CHAT_MULTIMODAL_QA_REQUIRED=false
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false
  CHAT_EXTERNAL_QA_REQUIRED=false
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false
)

expect 0 'all four flags explicitly false' 'PASS' "${ALL_FALSE[@]}"

expect 0 'letta full runtime QA can be required' 'CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=true' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=true

expect 0 'multimodal and external QA required' 'PASS' \
  CHAT_MULTIMODAL_QA_REQUIRED=true \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED=true \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect 0 'surrounding whitespace and mixed case are normalized' 'PASS' \
  'CHAT_MULTIMODAL_QA_REQUIRED=  TRUE ' \
  'CHAT_GENERATED_ARTIFACT_QA_REQUIRED=False' \
  'CHAT_EXTERNAL_QA_REQUIRED= false' \
  'CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=True '

for missing in \
  CHAT_MULTIMODAL_QA_REQUIRED \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED \
  CHAT_EXTERNAL_QA_REQUIRED \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED; do
  ARGS=()
  for entry in "${ALL_FALSE[@]}"; do
    [[ "${entry%%=*}" == "${missing}" ]] || ARGS+=("${entry}")
  done
  expect 1 "undefined ${missing} fails the gate" "${missing} is not defined" "${ARGS[@]}"
done

expect 1 'empty flag value fails the gate' 'CHAT_EXTERNAL_QA_REQUIRED is empty' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED= \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect 1 'non boolean flag value fails the gate' "must be exactly 'true' or 'false'" \
  CHAT_MULTIMODAL_QA_REQUIRED=yes \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect 1 'numeric flag value fails the gate' "must be exactly 'true' or 'false'" \
  CHAT_MULTIMODAL_QA_REQUIRED=1 \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=0 \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false

expect 1 'every invalid flag is reported at once' 'CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED must be exactly' \
  CHAT_MULTIMODAL_QA_REQUIRED=maybe \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=maybe \
  CHAT_EXTERNAL_QA_REQUIRED=maybe \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=maybe

expect 0 'artifact QA true with the full required combination' 'PASS' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect 1 'artifact QA true rejects a non openai Hermes protocol' 'requires HERMES_PROTOCOL=openai' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openclaw \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect 1 'artifact QA true rejects an undefined Hermes protocol' 'requires HERMES_PROTOCOL=openai' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect 1 'artifact QA true rejects a disabled artifact tool flag' 'requires HERMES_ARTIFACT_TOOL_ENABLED=true' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=false \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

expect 1 'artifact QA true rejects an undefined artifact envelope flag' 'requires HERMES_ARTIFACT_ENVELOPE_ENABLED=true' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=true

expect 0 'artifact QA true accepts normalized artifact settings' 'PASS' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  'CHAT_GENERATED_ARTIFACT_QA_REQUIRED= true' \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=OpenAI \
  'HERMES_ARTIFACT_TOOL_ENABLED=TRUE ' \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=True

expect 0 'artifact QA false ignores the Hermes artifact combination' 'PASS' \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=false \
  CHAT_EXTERNAL_QA_REQUIRED=false \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openclaw \
  HERMES_ARTIFACT_TOOL_ENABLED=false \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=false

expect 1 'an invalid flag is still reported when artifact QA is enabled' "CHAT_EXTERNAL_QA_REQUIRED must be exactly" \
  CHAT_MULTIMODAL_QA_REQUIRED=false \
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true \
  CHAT_EXTERNAL_QA_REQUIRED=enabled \
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=false \
  HERMES_PROTOCOL=openai \
  HERMES_ARTIFACT_TOOL_ENABLED=true \
  HERMES_ARTIFACT_ENVELOPE_ENABLED=true

if [[ "${FAILURES}" -ne 0 ]]; then
  printf 'FAIL: %s of %s staging QA gate cases failed.\n' "${FAILURES}" "${CASES}"
  exit 1
fi

printf 'PASS: %s staging QA gate cases passed.\n' "${CASES}"
