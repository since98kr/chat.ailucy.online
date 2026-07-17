#!/usr/bin/env bash
set -Eeuo pipefail

PLUGIN_FILE="$HOME/.hermes/plugins/lucy-harness/machine_validator.py"
HERMES_PY="$HOME/.hermes/hermes-agent/venv/bin/python"
VALIDATOR_CLI="$HOME/.local/bin/lucy-validator"
TASK_ID="TASK-SMOKE-001"
REPORT="$HOME/.hermes/lucy-control/artifacts/$TASK_ID/validation-report.json"
LOG="$HOME/lucy-validator-$TASK_ID.log"
BACKUP="$PLUGIN_FILE.before-volume-order-fix-$(date +%Y%m%d_%H%M%S)"

echo "=== 1. Preconditions ==="

test -x "$HERMES_PY" || {
  echo "FAIL: Hermes Python missing: $HERMES_PY"
  exit 1
}

test -f "$PLUGIN_FILE" || {
  echo "FAIL: Machine Validator source missing: $PLUGIN_FILE"
  exit 1
}

test -x "$VALIDATOR_CLI" || {
  echo "FAIL: Validator CLI missing: $VALIDATOR_CLI"
  exit 1
}

echo
echo "=== 2. Previous validator failure ==="

if [[ -f "$LOG" ]]; then
  tail -n 80 "$LOG" || true
else
  echo "No previous validator log found."
fi

echo
echo "=== 3. Apply targeted Docker argument-order fix ==="

cp -a "$PLUGIN_FILE" "$BACKUP"

"$HERMES_PY" - "$PLUGIN_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

old = '''        apply_command.extend([\n            "-v",\n            f"{artifact_dir}:/input:ro",\n            "sh",\n'''

new = '''        # Docker options must appear before the image name, which is\n        # the final element returned by docker_base().\n        apply_command[-1:-1] = [\n            "-v",\n            f"{artifact_dir}:/input:ro",\n        ]\n\n        apply_command.extend([\n            "sh",\n'''

if old in text:
    if text.count(old) != 1:
        raise SystemExit(
            f"FAIL: Expected exactly one vulnerable block, found {text.count(old)}"
        )
    text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")
    print("Targeted patch applied: PASS")
elif "apply_command[-1:-1]" in text and "f\"{artifact_dir}:/input:ro\"" in text:
    print("Targeted patch already present: PASS")
else:
    raise SystemExit(
        "FAIL: Expected validator anchor was not found; no file was modified."
    )
PY

echo "Backup: $BACKUP"

echo
echo "=== 4. Compile Validator ==="

"$HERMES_PY" -m py_compile "$PLUGIN_FILE"

echo "Python compile: PASS"

echo
echo "=== 5. Re-run Machine Validation ==="

set +e
"$VALIDATOR_CLI" "$TASK_ID" 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e

if [[ "$STATUS" -ne 0 ]]; then
  echo
  echo "FAIL: Machine Validator still failed after the targeted fix."
  echo "Log: $LOG"

  if [[ -f "$REPORT" ]]; then
    echo
    echo "=== Validation report summary ==="
    "$HERMES_PY" - "$REPORT" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
with path.open("r", encoding="utf-8") as stream:
    report = json.load(stream)

print("passed:", report.get("passed"))
print("scope_match:", report.get("scope_match"))
print("errors:")
for error in report.get("errors", []):
    print("-", error)

patch_apply = report.get("patch_apply")
if isinstance(patch_apply, dict):
    print("patch_apply.exit_code:", patch_apply.get("exit_code"))
    stderr = (patch_apply.get("stderr") or "").strip()
    stdout = (patch_apply.get("stdout") or "").strip()
    if stderr:
        print("patch_apply.stderr:", stderr)
    if stdout:
        print("patch_apply.stdout:", stdout)
PY
  fi

  exit "$STATUS"
fi

echo
echo "=== 6. Verify persisted validation state ==="

"$HERMES_PY" - "$REPORT" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])

if not path.is_file():
    raise SystemExit(f"FAIL: Validation report missing: {path}")

with path.open("r", encoding="utf-8") as stream:
    report = json.load(stream)

if report.get("passed") is not True:
    raise SystemExit(f"FAIL: persisted passed={report.get('passed')!r}")

if report.get("scope_match") is not True:
    raise SystemExit(f"FAIL: persisted scope_match={report.get('scope_match')!r}")

commands = report.get("commands")
if not isinstance(commands, list) or not commands:
    raise SystemExit("FAIL: No validation command results were recorded")

if not all(item.get("passed") is True for item in commands):
    raise SystemExit("FAIL: At least one validation command did not pass")

print("Patch application: PASS")
print("Changed-file scope: PASS")
print("Validation command: PASS")
print("Persisted Machine Validation: PASS")
PY

echo
echo "PASS: Machine Validator Docker volume-order bug fixed and validation passed."
