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

for command_name in gh curl python3; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

get_staging_variable() {
  local name="$1"
  gh api \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "repos/${REPO}/environments/${ENVIRONMENT}/variables/${name}" \
    --jq '.value'
}

EMAIL="$(get_staging_variable CHAT_ALLOWED_EMAILS | cut -d',' -f1)"
HERMES_AGENT="$(get_staging_variable HERMES_AGENT_ID)"
LETTA_AGENT="$(get_staging_variable LETTA_AGENT_ID)"

test -n "${EMAIL}" || fail 'CHAT_ALLOWED_EMAILS is empty'
test -n "${HERMES_AGENT}" || fail 'HERMES_AGENT_ID is empty'
test -n "${LETTA_AGENT}" || fail 'LETTA_AGENT_ID is empty'

AUTH_HEADER="Cf-Access-Authenticated-User-Email: ${EMAIL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

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

log 'Checking registered agents.'
curl -fsS \
  -H "${AUTH_HEADER}" \
  "${BASE}/api/agents" >"${TMP_DIR}/agents.json"
python3 - "${TMP_DIR}/agents.json" "${HERMES_AGENT}" "${LETTA_AGENT}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
agents = payload.get("agents", [])
ids = {agent.get("id") for agent in agents}
for expected in sys.argv[2:]:
    if expected not in ids:
        raise SystemExit(f"registered agent not found: {expected}")
PY

run_agent_smoke() {
  local system_id="$1"
  local agent_id="$2"
  local marker="$3"
  local slug="$4"
  local conversation_file="${TMP_DIR}/${slug}-conversation.json"
  local stream_file="${TMP_DIR}/${slug}-stream.ndjson"
  local payload
  local conversation_id
  local client_message_id

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

  curl -fsS \
    -H "${AUTH_HEADER}" \
    -H 'Content-Type: application/json' \
    --data "${payload}" \
    "${BASE}/api/conversations" >"${conversation_file}"

  conversation_id="$(python3 - "${conversation_file}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload["conversation"]["id"])
PY
)"

  client_message_id="smoke-${slug}-$(date +%s)-$$"
  payload="$(python3 - "${marker}" "${client_message_id}" <<'PY'
import json
import sys

print(json.dumps({
    "content": f"Chat V2 actual adapter smoke test. Reply with {sys.argv[1]} only.",
    "clientMessageId": sys.argv[2],
}))
PY
)"

  log "Calling ${system_id} through Chat V2."
  curl -fsS -N \
    -H "${AUTH_HEADER}" \
    -H 'Content-Type: application/json' \
    --data "${payload}" \
    "${BASE}/api/conversations/${conversation_id}/messages/stream" >"${stream_file}"

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

run_agent_smoke hermes "${HERMES_AGENT}" CHAT_V2_HERMES_OK hermes
run_agent_smoke letta "${LETTA_AGENT}" CHAT_V2_LETTA_OK letta

log 'PASS: staging, authentication, Hermes, and Letta are all healthy.'
