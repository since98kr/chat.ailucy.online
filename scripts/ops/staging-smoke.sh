#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${CHAT_REPO:-since98kr/chat.ailucy.online}"
ENVIRONMENT="${CHAT_ENVIRONMENT_NAME:-staging}"
BASE="${CHAT_STAGING_BASE_URL:-http://127.0.0.1:14174}"

log() {
  printf '[chat-v2-smoke] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in curl python3; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

get_staging_variable() {
  local name="$1"
  command -v gh >/dev/null 2>&1 || fail 'missing command: gh'
  gh auth status >/dev/null
  gh api \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/${REPO}/environments/${ENVIRONMENT}/variables/${name}" \
    --jq '.value'
}

EMAIL="${CHAT_STAGING_EMAIL:-}"
if [[ -z "${EMAIL}" ]]; then
  EMAIL="$(get_staging_variable CHAT_ALLOWED_EMAILS)"
fi
EMAIL="$(printf '%s' "${EMAIL}" | cut -d',' -f1 | xargs)"
test -n "${EMAIL}" || fail 'CHAT_ALLOWED_EMAILS is empty'

AUTH_HEADER="Cf-Access-Authenticated-User-Email: ${EMAIL}"
TMP_DIR="$(mktemp -d)"
declare -a CREATED_CONVERSATION_IDS=()

cleanup() {
  local status=$?
  set +e
  for conversation_id in "${CREATED_CONVERSATION_IDS[@]}"; do
    curl -sS \
      -H "${AUTH_HEADER}" \
      -H 'Content-Type: application/json' \
      -X PATCH \
      --data '{"status":"trashed"}' \
      "${BASE}/api/conversations/${conversation_id}" >/dev/null 2>&1
    curl -sS \
      -H "${AUTH_HEADER}" \
      -X DELETE \
      "${BASE}/api/conversations/${conversation_id}" >/dev/null 2>&1
  done
  rm -rf "${TMP_DIR}"
  return "${status}"
}
trap cleanup EXIT

log 'Checking staging health.'
curl -fsS "${BASE}/api/health" >"${TMP_DIR}/health.json"
python3 - "${TMP_DIR}/health.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if not payload.get("ok"):
    raise SystemExit("staging health is not ok")
PY

log 'Checking authenticated operations status.'
curl -fsS \
  -H "${AUTH_HEADER}" \
  "${BASE}/api/ops/status" >"${TMP_DIR}/ops.json"
python3 - "${TMP_DIR}/ops.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if not payload.get("ok"):
    raise SystemExit("staging ops status is not ok")
PY

log 'Selecting registered Chat V2 agents.'
curl -fsS \
  -H "${AUTH_HEADER}" \
  "${BASE}/api/agents" >"${TMP_DIR}/agents.json"

mapfile -t CHAT_AGENT_IDS < <(
  python3 - "${TMP_DIR}/agents.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
agents = payload.get("agents", [])


def select(system_id: str) -> str:
    candidates = [
        agent for agent in agents
        if agent.get("systemId") == system_id
        and agent.get("enabled") is not False
        and agent.get("directChatEnabled") is not False
    ]
    if not candidates:
        raise SystemExit(f"no enabled direct-chat agent registered for system: {system_id}")

    def score(agent: dict) -> tuple:
        text = " ".join(str(agent.get(key, "")) for key in ("id", "displayName", "shortName")).lower()
        return (
            0 if agent.get("isLead") else 1,
            0 if "lucy" in text else 1,
            int(agent.get("sortOrder", 999999)),
            str(agent.get("id", "")),
        )

    selected = sorted(candidates, key=score)[0]
    agent_id = selected.get("id")
    if not agent_id:
        raise SystemExit(f"selected agent has no id for system: {system_id}")
    return str(agent_id)


print(select("hermes"))
print(select("letta"))
PY
)

[[ "${#CHAT_AGENT_IDS[@]}" -eq 2 ]] || fail 'could not resolve Hermes and Letta Chat V2 agent IDs'
HERMES_CHAT_AGENT="${CHAT_AGENT_IDS[0]}"
LETTA_CHAT_AGENT="${CHAT_AGENT_IDS[1]}"

log "Selected Hermes Chat V2 agent: ${HERMES_CHAT_AGENT}"
log "Selected Letta Chat V2 agent: ${LETTA_CHAT_AGENT}"

run_agent_smoke() {
  local system_id="$1"
  local agent_id="$2"
  local marker="$3"
  local slug="$4"
  local conversation_file="${TMP_DIR}/${slug}-conversation.json"
  local stream_file="${TMP_DIR}/${slug}-stream.ndjson"
  local payload
  local conversation_id
  local http_status

  payload="$(python3 - "${system_id}" "${agent_id}" <<'PY'
import json
import sys

print(json.dumps({
    "systemId": sys.argv[1],
    "agentId": sys.argv[2],
    "title": f"{sys.argv[1].title()} staging smoke test",
}))
PY
)"

  if ! http_status="$(
    curl -sS \
      -o "${conversation_file}" \
      -w '%{http_code}' \
      -H "${AUTH_HEADER}" \
      -H 'Content-Type: application/json' \
      --data "${payload}" \
      "${BASE}/api/conversations"
  )"; then
    cat "${conversation_file}" >&2 2>/dev/null || true
    fail "conversation creation request failed for ${system_id}"
  fi
  if [[ ! "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
    log "Conversation creation returned HTTP ${http_status} for ${system_id}:"
    cat "${conversation_file}" >&2 2>/dev/null || true
    fail "conversation creation failed for ${system_id}"
  fi

  conversation_id="$(python3 - "${conversation_file}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload["conversation"]["id"])
PY
)"
  CREATED_CONVERSATION_IDS+=("${conversation_id}")

  payload="$(python3 - "${marker}" <<'PY'
import json
import sys
import uuid

print(json.dumps({
    "content": f"Chat V2 actual adapter smoke test. Reply with {sys.argv[1]} only.",
    "clientMessageId": str(uuid.uuid4()),
}))
PY
)"

  log "Calling ${system_id} through Chat V2."
  if ! http_status="$(
    curl -sS -N \
      -o "${stream_file}" \
      -w '%{http_code}' \
      -H "${AUTH_HEADER}" \
      -H 'Content-Type: application/json' \
      --data "${payload}" \
      "${BASE}/api/conversations/${conversation_id}/messages/stream"
  )"; then
    cat "${stream_file}" >&2 2>/dev/null || true
    fail "message stream request failed for ${system_id}"
  fi
  if [[ ! "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
    log "Message stream returned HTTP ${http_status} for ${system_id}:"
    cat "${stream_file}" >&2 2>/dev/null || true
    fail "message stream failed for ${system_id}"
  fi

  python3 - "${stream_file}" "${marker}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
marker = sys.argv[2]
parts = []
failure = None

for line in path.read_text().splitlines():
    if not line.strip():
        continue
    event = json.loads(line)
    event_type = event.get("type")
    if event_type == "content.delta":
        parts.append(event.get("delta", ""))
    elif event_type == "run.completed":
        content = event.get("message", {}).get("content")
        if content:
            parts = [content]
    elif event_type == "run.failed":
        failure = event.get("error", "unknown error")

if failure:
    raise SystemExit(f"adapter run failed: {failure}")

text = "".join(parts).strip()
if marker not in text:
    raise SystemExit(f"expected marker not found: {marker}; response={text!r}")

print(marker)
PY
}

run_agent_smoke hermes "${HERMES_CHAT_AGENT}" CHAT_V2_HERMES_OK hermes
run_agent_smoke letta "${LETTA_CHAT_AGENT}" CHAT_V2_LETTA_OK letta

log 'PASS: staging, authentication, Hermes, and Letta are all healthy.'
