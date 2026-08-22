#!/usr/bin/env bash
# Fail-closed guard for the staging QA gate configuration.
#
# This file is both a sourceable library and a small CLI so that the same
# validation runs in the deployment workflow, in the host preflight wrapper,
# and in a focused test that needs neither Docker nor network access.
#
# Policy:
#   - every CHAT_*_QA_REQUIRED gate variable must be defined explicitly as the
#     lowercase literal 'true' or 'false'; unset, empty, 'TRUE', 'True', 'yes',
#     '1' and every other value are rejected
#   - when CHAT_GENERATED_ARTIFACT_QA_REQUIRED is 'true', the Hermes artifact
#     transport contract must hold before the runtime container is started
#
# Usage:
#   bash scripts/ops/staging-qa-gate-guard.sh [validate-vars|enforce-artifact-contract|enforce-all]
#   source scripts/ops/staging-qa-gate-guard.sh

QA_GATE_REQUIRED_VARS=(
  CHAT_MULTIMODAL_QA_REQUIRED
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED
  CHAT_EXTERNAL_QA_REQUIRED
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED
)

# Contract enforced only when CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true.
QA_GATE_ARTIFACT_CONTRACT=(
  'HERMES_PROTOCOL=openai'
  'HERMES_ARTIFACT_TOOL_ENABLED=true'
  'HERMES_ARTIFACT_ENVELOPE_ENABLED=true'
)

qa_gate_log() {
  printf '[staging-qa-gate] %s\n' "$*"
}

qa_gate_error() {
  printf '[staging-qa-gate] ERROR: %s\n' "$*" >&2
}

# qa_gate_check_explicit_boolean NAME
# Returns 0 when NAME is defined and is exactly 'true' or 'false'.
qa_gate_check_explicit_boolean() {
  local name="${1:?qa_gate_check_explicit_boolean requires a variable name}"
  local value

  if [[ -z "${!name+set}" ]]; then
    qa_gate_error "${name} is not defined. Define it explicitly as 'true' or 'false' in the staging environment; a missing gate is never treated as disabled."
    return 1
  fi

  value="${!name}"

  if [[ -z "${value}" ]]; then
    qa_gate_error "${name} is defined but empty. Define it explicitly as 'true' or 'false'; an empty value is never treated as 'false'."
    return 1
  fi

  if [[ "${value}" != 'true' && "${value}" != 'false' ]]; then
    qa_gate_error "${name} must be exactly 'true' or 'false' (lowercase), received '${value}'."
    return 1
  fi

  return 0
}

# Validates every required QA gate variable and reports all violations at once.
qa_gate_validate_required_vars() {
  local name
  local failures=0

  for name in "${QA_GATE_REQUIRED_VARS[@]}"; do
    qa_gate_check_explicit_boolean "${name}" || failures=$((failures + 1))
  done

  if [[ "${failures}" -ne 0 ]]; then
    qa_gate_error "${failures} staging QA gate variable(s) are not explicitly set. Refusing to continue: an unset or malformed gate would silently skip its Playwright spec and report a green deployment."
    return 1
  fi

  qa_gate_log "All ${#QA_GATE_REQUIRED_VARS[@]} staging QA gate variables are explicitly set."
  return 0
}

# Enforces the Hermes artifact transport contract for the generated artifact gate.
qa_gate_enforce_generated_artifact_contract() {
  local required="${CHAT_GENERATED_ARTIFACT_QA_REQUIRED-}"
  local entry name expected actual
  local failures=0

  if [[ "${required}" != 'true' ]]; then
    return 0
  fi

  for entry in "${QA_GATE_ARTIFACT_CONTRACT[@]}"; do
    name="${entry%%=*}"
    expected="${entry#*=}"

    if [[ -z "${!name+set}" ]]; then
      qa_gate_error "CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true requires ${name}=${expected}, but ${name} is not defined."
      failures=$((failures + 1))
      continue
    fi

    actual="${!name}"
    if [[ "${actual}" != "${expected}" ]]; then
      qa_gate_error "CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true requires ${name}=${expected}, received '${actual}'."
      failures=$((failures + 1))
    fi
  done

  if [[ "${failures}" -ne 0 ]]; then
    qa_gate_error 'Generated artifact QA contract violated. Refusing to start the staging runtime container.'
    return 1
  fi

  qa_gate_log 'Generated artifact QA contract satisfied (HERMES_PROTOCOL=openai, HERMES_ARTIFACT_TOOL_ENABLED=true, HERMES_ARTIFACT_ENVELOPE_ENABLED=true).'
  return 0
}

qa_gate_main() {
  local command="${1:-enforce-all}"
  local status=0

  case "${command}" in
    validate-vars)
      qa_gate_validate_required_vars || status=1
      ;;
    enforce-artifact-contract)
      qa_gate_enforce_generated_artifact_contract || status=1
      ;;
    enforce-all)
      qa_gate_validate_required_vars || status=1
      qa_gate_enforce_generated_artifact_contract || status=1
      ;;
    *)
      qa_gate_error "unknown command: ${command} (expected validate-vars, enforce-artifact-contract, or enforce-all)"
      return 2
      ;;
  esac

  return "${status}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -Eeuo pipefail
  qa_gate_main "$@"
fi
