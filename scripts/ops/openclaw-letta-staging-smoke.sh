#!/usr/bin/env bash
set -Eeuo pipefail

BASE="${CHAT_STAGING_BASE_URL:-http://127.0.0.1:14174}"
EMAIL="${CHAT_STAGING_EMAIL:-}"
EVIDENCE_DIR="${CHAT_STAGING_EVIDENCE_DIR:-test-results-staging-browser/openclaw-letta}"

log() {
  printf '[chat-v2-openclaw-letta] %s\n' "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

for command_name in curl python3; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "missing command: ${command_name}"
done

EMAIL="$(printf '%s' "${EMAIL}" | cut -d',' -f1 | xargs)"
[[ -n "${EMAIL}" ]] || fail 'CHAT_STAGING_EMAIL is required'
AUTH_HEADER="Cf-Access-Authenticated-User-Email: ${EMAIL}"
TMP_DIR="$(mktemp -d)"
CONVERSATION_ID=''

cleanup() {
  local status=$?
  set +e
  mkdir -p "${EVIDENCE_DIR}"
  chmod 0700 "${EVIDENCE_DIR}"
  for source in "${TMP_DIR}"/*.json "${TMP_DIR}"/*.ndjson; do
    [[ -f "${source}" ]] || continue
    cp "${source}" "${EVIDENCE_DIR}/$(basename "${source}")"
    chmod 0600 "${EVIDENCE_DIR}/$(basename "${source}")"
  done
  if [[ -n "${CONVERSATION_ID}" ]]; then
    curl -sS -H "${AUTH_HEADER}" -H 'Content-Type: application/json' -X PATCH \
      --data '{"status":"trashed"}' "${BASE}/api/conversations/${CONVERSATION_ID}" >/dev/null 2>&1 || true
    curl -sS -H "${AUTH_HEADER}" -X DELETE \
      "${BASE}/api/conversations/${CONVERSATION_ID}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
  return "${status}"
}
trap cleanup EXIT

log 'Selecting the registered Letta Lucy agent.'
curl -fsS -H "${AUTH_HEADER}" "${BASE}/api/agents" >"${TMP_DIR}/agents.json"
LETTA_AGENT="$(python3 - "${TMP_DIR}/agents.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
agents = [a for a in payload.get('agents', [])
          if a.get('systemId') == 'letta'
          and a.get('enabled') is not False
          and a.get('directChatEnabled') is not False]
if not agents:
    raise SystemExit('no Letta direct-chat agent')
agents.sort(key=lambda a: (
    0 if a.get('isLead') else 1,
    0 if 'lucy' in ' '.join(str(a.get(k, '')) for k in ('id','displayName','shortName')).lower() else 1,
    int(a.get('sortOrder', 999999)),
    str(a.get('id', '')),
))
print(agents[0]['id'])
PY
)"
[[ -n "${LETTA_AGENT}" ]] || fail 'could not select Letta Lucy'

log 'Creating one Chat Conversation for the two-turn OpenClaw session proof.'
CREATE_PAYLOAD="$(python3 - "${LETTA_AGENT}" <<'PY'
import json, sys
print(json.dumps({'systemId':'letta','agentId':sys.argv[1],'title':'OpenClaw continuity staging proof'}))
PY
)"
curl -fsS -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
  --data "${CREATE_PAYLOAD}" "${BASE}/api/conversations" >"${TMP_DIR}/conversation.json"
CONVERSATION_ID="$(python3 - "${TMP_DIR}/conversation.json" <<'PY'
import json, sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text())['conversation']['id'])
PY
)"

MARKER="CHAT_OPENCLAW_SESSION_$(python3 - <<'PY'
import uuid
print(uuid.uuid4().hex.upper())
PY
)"

send_turn() {
  local content="$1"
  local output="$2"
  local payload
  payload="$(python3 - "${content}" <<'PY'
import json, sys, uuid
print(json.dumps({'content':sys.argv[1],'clientMessageId':str(uuid.uuid4())}))
PY
)"
  curl -fsS -N -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
    --data "${payload}" "${BASE}/api/conversations/${CONVERSATION_ID}/messages/stream" >"${output}"
}

validate_success() {
  local path="$1"
  python3 - "${path}" <<'PY'
import json, sys
from pathlib import Path
completed = 0
failed = []
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line.strip():
        continue
    event = json.loads(line)
    if event.get('type') == 'run.completed':
        completed += 1
    elif event.get('type') == 'run.failed':
        failed.append(event.get('error', 'unknown'))
if failed:
    raise SystemExit(f'run.failed: {failed}')
if completed != 1:
    raise SystemExit(f'expected exactly one run.completed, got {completed}')
PY
}

log 'Turn 1: planting a random continuity marker.'
send_turn "Remember this exact token for the immediately following turn: ${MARKER}. Reply only with ACK." "${TMP_DIR}/turn-1.ndjson"
validate_success "${TMP_DIR}/turn-1.ndjson"

log 'Turn 2: requiring the previous-turn marker without Chat transcript replay.'
send_turn 'What exact token did I ask you to remember in the immediately previous turn? Reply with the token only.' "${TMP_DIR}/turn-2.ndjson"
validate_success "${TMP_DIR}/turn-2.ndjson"
python3 - "${TMP_DIR}/turn-2.ndjson" "${MARKER}" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
marker = sys.argv[2]
parts = []
for line in path.read_text().splitlines():
    if not line.strip():
        continue
    event = json.loads(line)
    if event.get('type') == 'content.delta':
        parts.append(str(event.get('delta', '')))
    elif event.get('type') == 'run.completed':
        content = event.get('message', {}).get('content')
        if content:
            parts = [str(content)]
text = ''.join(parts).strip()
if marker not in text:
    raise SystemExit(f'OpenClaw session continuity marker missing; response={text!r}')
PY

python3 - "${TMP_DIR}/result.json" "${CONVERSATION_ID}" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    'ok': True,
    'system': 'letta',
    'transport': 'openclaw',
    'conversation_id_present': bool(sys.argv[2]),
    'two_turn_session_continuity': True,
}, indent=2) + '\n')
PY

log 'PASS: the same Chat Conversation preserved Letta Lucy continuity through OpenClaw.'
