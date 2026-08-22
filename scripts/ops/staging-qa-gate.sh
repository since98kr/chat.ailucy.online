#!/usr/bin/env bash
# Validates the staging QA required flags before any deployment side effect runs.
#
# Every flag below must be defined in the staging environment variables and must
# hold exactly 'true' or 'false'. Undefined, empty, or any other value fails the
# gate (fail-closed) so a deploy can never silently skip a required QA stage.
#
# This script has no Docker, network, or filesystem dependency so it can be run
# from the workflow, from the preflight wrapper, and from unit tests.
set -Eeuo pipefail

QA_FLAG_NAMES=(
  CHAT_MULTIMODAL_QA_REQUIRED
  CHAT_GENERATED_ARTIFACT_QA_REQUIRED
  CHAT_EXTERNAL_QA_REQUIRED
  CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED
)

# Flags that must be enabled together with the generated artifact QA stage.
ARTIFACT_REQUIRED_TRUE_FLAGS=(
  HERMES_ARTIFACT_TOOL_ENABLED
  HERMES_ARTIFACT_ENVELOPE_ENABLED
)

log() {
  printf '[chat-v2-qa-gate] %s\n' "$*"
}

qa_gate_normalize() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value,,}"
}

ERRORS=()
declare -A QA_FLAG_VALUES=()

for name in "${QA_FLAG_NAMES[@]}"; do
  if [[ -z "${!name+defined}" ]]; then
    ERRORS+=("${name} is not defined; declare it in the staging environment variables as 'true' or 'false'.")
    continue
  fi

  raw="${!name}"
  value="$(qa_gate_normalize "${raw}")"
  case "${value}" in
    true | false)
      QA_FLAG_VALUES["${name}"]="${value}"
      ;;
    '')
      ERRORS+=("${name} is empty; it must be exactly 'true' or 'false'.")
      ;;
    *)
      ERRORS+=("${name} must be exactly 'true' or 'false' (received: '${raw}').")
      ;;
  esac
done

if [[ "${QA_FLAG_VALUES[CHAT_GENERATED_ARTIFACT_QA_REQUIRED]-}" == 'true' ]]; then
  protocol="$(qa_gate_normalize "${HERMES_PROTOCOL-}")"
  if [[ "${protocol}" != 'openai' ]]; then
    ERRORS+=("CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true requires HERMES_PROTOCOL=openai (received: '${HERMES_PROTOCOL-<undefined>}').")
  fi

  for name in "${ARTIFACT_REQUIRED_TRUE_FLAGS[@]}"; do
    value="$(qa_gate_normalize "${!name-}")"
    if [[ "${value}" != 'true' ]]; then
      ERRORS+=("CHAT_GENERATED_ARTIFACT_QA_REQUIRED=true requires ${name}=true (received: '${!name-<undefined>}').")
    fi
  done
fi

if ((${#ERRORS[@]} > 0)); then
  log 'FAIL: staging QA required flags are not deployable.'
  for message in "${ERRORS[@]}"; do
    log "ERROR: ${message}"
  done
  exit 1
fi

for name in "${QA_FLAG_NAMES[@]}"; do
  log "${name}=${QA_FLAG_VALUES[${name}]}"
done

if [[ "${QA_FLAG_VALUES[CHAT_GENERATED_ARTIFACT_QA_REQUIRED]}" == 'true' ]]; then
  log 'Generated artifact QA is required: HERMES_PROTOCOL=openai, artifact tool and envelope flags are enabled.'
fi

log 'PASS: staging QA required flags are explicit and consistent.'
