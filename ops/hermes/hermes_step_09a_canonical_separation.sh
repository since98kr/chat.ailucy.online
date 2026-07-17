#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_REPO="$HOME/hermes-workspaces/smoke"
CANONICAL_ROOT="$HOME/hermes-projects/xixi-smoke"
TASK_WORKSPACE="$HOME/hermes-workspaces/tasks/TASK-SMOKE-001"

PROJECTS_FILE="$HOME/.hermes/lucy-control/projects.yaml"
VALIDATION_REPORT="$HOME/.hermes/lucy-control/artifacts/TASK-SMOKE-001/validation-report.json"

HERMES_PY="$HOME/.hermes/hermes-agent/venv/bin/python"
BACKUP="$HOME/hermes-before-canonical-separation-$(date +%Y%m%d_%H%M%S)"

echo "=== 1. Preconditions ==="

test -x "$HERMES_PY" || {
  echo "FAIL: Hermes Python missing."
  exit 1
}

test -d "$SOURCE_REPO/.git" || {
  echo "FAIL: Smoke source repository missing: $SOURCE_REPO"
  exit 1
}

test -f "$PROJECTS_FILE" || {
  echo "FAIL: Project registry missing."
  exit 1
}

test -f "$VALIDATION_REPORT" || {
  echo "FAIL: Machine Validation report missing."
  exit 1
}

echo
echo "=== 2. Confirm Machine Validation passed ==="

"$HERMES_PY" - "$VALIDATION_REPORT" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])

with path.open("r", encoding="utf-8") as stream:
    report = json.load(stream)

if report.get("passed") is not True:
    raise SystemExit("FAIL: Machine Validation has not passed.")

if report.get("scope_match") is not True:
    raise SystemExit("FAIL: Machine Validation scope did not match.")

print("Machine Validation: PASS")
print("Validated HEAD:", report.get("project_head"))
PY

echo
echo "=== 3. Backup registry and workspace metadata ==="

mkdir -p "$BACKUP"

cp -a "$PROJECTS_FILE" "$BACKUP/projects.yaml"
git -C "$SOURCE_REPO" status --short --branch \
  > "$BACKUP/source-git-status.txt"
git -C "$SOURCE_REPO" rev-parse HEAD \
  > "$BACKUP/source-head.txt"

echo "Backup: $BACKUP"

echo
echo "=== 4. Create clean canonical repository ==="

mkdir -p "$HOME/hermes-projects"

if [[ -e "$CANONICAL_ROOT" ]]; then
  echo "FAIL: Canonical path already exists: $CANONICAL_ROOT"
  exit 1
fi

git clone \
  --quiet \
  --no-hardlinks \
  "$SOURCE_REPO" \
  "$CANONICAL_ROOT"

CANONICAL_STATUS="$(
  git -C "$CANONICAL_ROOT" status --porcelain
)"

if [[ -n "$CANONICAL_STATUS" ]]; then
  echo "FAIL: Newly cloned canonical repository is not clean."
  echo "$CANONICAL_STATUS"
  exit 1
fi

test ! -e "$CANONICAL_ROOT/xixi-created.txt" || {
  echo "FAIL: Candidate change leaked into canonical clone."
  exit 1
}

echo "Canonical repository: $CANONICAL_ROOT"
echo "Canonical HEAD: $(git -C "$CANONICAL_ROOT" rev-parse HEAD)"

echo
echo "=== 5. Confirm canonical HEAD matches validation HEAD ==="

"$HERMES_PY" - \
  "$VALIDATION_REPORT" \
  "$CANONICAL_ROOT" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
canonical_root = Path(sys.argv[2])

with report_path.open("r", encoding="utf-8") as stream:
    report = json.load(stream)

validated_head = report.get("project_head")

canonical_head = subprocess.check_output(
    [
        "git",
        "-C",
        str(canonical_root),
        "rev-parse",
        "HEAD",
    ],
    text=True,
).strip()

if canonical_head != validated_head:
    raise SystemExit(
        "FAIL: Canonical HEAD differs from validated HEAD.\n"
        f"validated={validated_head}\n"
        f"canonical={canonical_head}"
    )

print("Canonical and validated HEAD match: PASS")
PY

echo
echo "=== 6. Move old candidate into task workspace ==="

mkdir -p "$HOME/hermes-workspaces/tasks"

if [[ -e "$TASK_WORKSPACE" ]]; then
  echo "FAIL: Task workspace already exists: $TASK_WORKSPACE"
  exit 1
fi

mv "$SOURCE_REPO" "$TASK_WORKSPACE"

test -f "$TASK_WORKSPACE/xixi-created.txt" || {
  echo "FAIL: Candidate file missing after workspace move."
  exit 1
}

grep -Fxq \
  'XIXI_SANDBOX_WRITE_OK' \
  "$TASK_WORKSPACE/xixi-created.txt" || {
    echo "FAIL: Candidate content changed."
    exit 1
  }

echo "Task workspace: $TASK_WORKSPACE"

echo
echo "=== 7. Update project registry ==="

"$HERMES_PY" - \
  "$PROJECTS_FILE" \
  "$CANONICAL_ROOT" \
  "$HOME/hermes-workspaces/tasks" <<'PY'
from pathlib import Path
import sys
import yaml

registry_path = Path(sys.argv[1])
canonical_root = Path(sys.argv[2]).resolve()
workspace_root = Path(sys.argv[3]).resolve()

with registry_path.open("r", encoding="utf-8") as stream:
    registry = yaml.safe_load(stream) or {}

projects = registry.get("projects")

if not isinstance(projects, dict):
    raise SystemExit("FAIL: projects mapping is missing.")

project = projects.get("xixi-smoke")

if not isinstance(project, dict):
    raise SystemExit("FAIL: xixi-smoke project is missing.")

project["root"] = str(canonical_root)
project["workspace_root"] = str(workspace_root)
project["workspace_mode"] = "git-worktree"
project["apply_mode"] = "validated-patch"
project["require_clean_canonical"] = True
project["tei_approval_required"] = True

temporary = registry_path.with_suffix(".yaml.tmp")

with temporary.open("w", encoding="utf-8") as stream:
    yaml.safe_dump(
        registry,
        stream,
        sort_keys=False,
        allow_unicode=True,
    )

temporary.replace(registry_path)

print("Registered canonical root:", canonical_root)
print("Registered workspace root:", workspace_root)
PY

chmod 600 "$PROJECTS_FILE"

echo
echo "=== 8. Verify final topology ==="

"$HERMES_PY" - "$PROJECTS_FILE" <<'PY'
from pathlib import Path
import sys
import yaml

with Path(sys.argv[1]).open(
    "r",
    encoding="utf-8",
) as stream:
    registry = yaml.safe_load(stream) or {}

project = registry["projects"]["xixi-smoke"]

required = {
    "workspace_mode": "git-worktree",
    "apply_mode": "validated-patch",
    "require_clean_canonical": True,
    "tei_approval_required": True,
}

for key, expected in required.items():
    actual = project.get(key)

    if actual != expected:
        raise SystemExit(
            f"FAIL: {key}: expected {expected!r}, got {actual!r}"
        )

print("Canonical root:", project["root"])
print("Workspace root:", project["workspace_root"])
print("Workspace mode:", project["workspace_mode"])
print("Apply mode:", project["apply_mode"])
print("Approval required:", project["tei_approval_required"])
PY

test -z "$(
  git -C "$CANONICAL_ROOT" status --porcelain
)" || {
  echo "FAIL: Canonical repository is not clean."
  exit 1
}

test -f "$TASK_WORKSPACE/xixi-created.txt" || {
  echo "FAIL: Task workspace candidate missing."
  exit 1
}

echo
echo "Canonical repository clean: PASS"
echo "Candidate workspace preserved: PASS"
echo "Project Registry updated: PASS"
echo
echo "PASS: Canonical and task workspace separation completed."
