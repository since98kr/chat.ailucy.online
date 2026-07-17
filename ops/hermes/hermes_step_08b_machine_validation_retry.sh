#!/usr/bin/env bash
set -Eeuo pipefail

TASK_ID="TASK-SMOKE-001"
VALIDATOR="$HOME/.local/bin/lucy-validator"
HARNESS="$HOME/.local/bin/lucy-harness"
REPORT="$HOME/.hermes/lucy-control/artifacts/$TASK_ID/validation-report.json"
LOG="$HOME/lucy-validator-$TASK_ID.log"
HERMES_PY="$HOME/.hermes/hermes-agent/venv/bin/python"

echo "=== 1. Preconditions ==="

if [[ ! -x "$VALIDATOR" ]]; then
  echo "FAIL: lucy-validator is missing: $VALIDATOR"
  exit 1
fi

if [[ ! -x "$HARNESS" ]]; then
  echo "FAIL: lucy-harness is missing: $HARNESS"
  exit 1
fi

if [[ ! -x "$HERMES_PY" ]]; then
  echo "FAIL: Hermes Python is missing: $HERMES_PY"
  exit 1
fi

rm -f "$LOG"

echo
echo "=== 2. Current workflow status ==="
set +e
"$HARNESS" status "$TASK_ID"
STATUS_BEFORE=$?
set -e

echo
echo "=== 3. Run Machine Validator ==="
set +e
"$VALIDATOR" "$TASK_ID" 2>&1 | tee "$LOG"
VALIDATOR_STATUS=${PIPESTATUS[0]}
set -e

echo
echo "Validator exit status: $VALIDATOR_STATUS"
echo "Validator log: $LOG"

echo
echo "=== 4. Validation report summary ==="

if [[ ! -f "$REPORT" ]]; then
  echo "FAIL: validation-report.json was not created: $REPORT"
  echo
  echo "=== Last 120 validator log lines ==="
  tail -n 120 "$LOG" || true
  exit 2
fi

"$HERMES_PY" - "$REPORT" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
with path.open("r", encoding="utf-8") as stream:
    report = json.load(stream)

print("passed:", report.get("passed"))
print("scope_match:", report.get("scope_match"))
print("project_head:", report.get("project_head"))
print("image:", report.get("image"))
print("network:", report.get("network"))
print("declared_changed_files:", report.get("declared_changed_files"))
print("actual_changed_files:", report.get("actual_changed_files"))
print("errors:")
for error in report.get("errors", []):
    print(" -", error)

print("commands:")
for index, command in enumerate(report.get("commands", []), start=1):
    print(f" [{index}] passed={command.get('passed')} exit_code={command.get('exit_code')}")
    print("     command:", command.get("command"))
    if command.get("stdout"):
        print("     stdout:", command.get("stdout")[-1000:])
    if command.get("stderr"):
        print("     stderr:", command.get("stderr")[-1000:])
PY

echo
echo "=== 5. Final workflow status ==="
set +e
"$HARNESS" status "$TASK_ID"
FINAL_STATUS=$?
set -e

PASSED="$($HERMES_PY - "$REPORT" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as stream:
    print("true" if json.load(stream).get("passed") is True else "false")
PY
)"

if [[ "$PASSED" != "true" ]]; then
  echo
  echo "FAIL: Machine Validation is still not passing."
  echo "The detailed cause is shown above and saved in: $LOG"
  exit 3
fi

echo
echo "PASS: Machine Validation passed."
echo "Next: rerun Hermes step 09a."
