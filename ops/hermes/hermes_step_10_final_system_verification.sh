#!/usr/bin/env bash
set -Eeuo pipefail

TASK_ID="TASK-SMOKE-001"
HERMES_HOME="$HOME/.hermes"
HERMES_PY="$HERMES_HOME/hermes-agent/venv/bin/python"
CONTROL_HOME="$HERMES_HOME/lucy-control"
PLUGIN_HOME="$HERMES_HOME/plugins/lucy-harness"
PROJECTS_FILE="$CONTROL_HOME/projects.yaml"
WORKFLOW_FILE="$CONTROL_HOME/workflows/$TASK_ID.json"
VALIDATION_REPORT="$CONTROL_HOME/artifacts/$TASK_ID/validation-report.json"
FINAL_REPORT="$CONTROL_HOME/final-system-verification.json"

echo "=== 1. Command and file preconditions ==="

for command_name in \
  lucy xixi lynn gemma \
  lucy-harness lucy-validator lucy-approval
 do
  command -v "$command_name" >/dev/null || {
    echo "FAIL: command not found: $command_name"
    exit 1
  }
  echo "Command available: $command_name"
done

for path in \
  "$HERMES_PY" \
  "$PROJECTS_FILE" \
  "$WORKFLOW_FILE" \
  "$VALIDATION_REPORT" \
  "$PLUGIN_HOME/__init__.py" \
  "$PLUGIN_HOME/tools.py" \
  "$PLUGIN_HOME/gates.py" \
  "$PLUGIN_HOME/machine_validator.py"
 do
  test -e "$path" || {
    echo "FAIL: required path missing: $path"
    exit 1
  }
done

echo
echo "=== 2. Compile Lucy Harness plugin ==="

"$HERMES_PY" -m py_compile \
  "$PLUGIN_HOME/__init__.py" \
  "$PLUGIN_HOME/tools.py" \
  "$PLUGIN_HOME/gates.py" \
  "$PLUGIN_HOME/machine_validator.py"

echo "Plugin compile: PASS"

echo
echo "=== 3. Validate profiles, gates, topology, and canonical state ==="

"$HERMES_PY" - \
  "$HOME/.hermes/config.yaml" \
  "$HOME/.hermes/profiles/xixi/config.yaml" \
  "$HOME/.hermes/profiles/lynn/config.yaml" \
  "$HOME/.hermes/profiles/gemma/config.yaml" \
  "$PROJECTS_FILE" \
  "$WORKFLOW_FILE" \
  "$VALIDATION_REPORT" \
  "$FINAL_REPORT" <<'PY'
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import subprocess
import sys

import yaml

(
    lucy_config_path,
    xixi_config_path,
    lynn_config_path,
    gemma_config_path,
    projects_path,
    workflow_path,
    validation_path,
    final_report_path,
) = map(Path, sys.argv[1:])


def load_yaml(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = yaml.safe_load(stream) or {}
    if not isinstance(value, dict):
        raise SystemExit(f"FAIL: YAML root is not a mapping: {path}")
    return value


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise SystemExit(f"FAIL: JSON root is not an object: {path}")
    return value


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def git(root: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(root), *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        fail(
            f"git {' '.join(args)} failed in {root}: "
            f"{completed.stderr.strip()}"
        )
    return completed.stdout.strip()


lucy = load_yaml(lucy_config_path)
xixi = load_yaml(xixi_config_path)
lynn = load_yaml(lynn_config_path)
gemma = load_yaml(gemma_config_path)
projects = load_yaml(projects_path)
workflow = load_json(workflow_path)
validation = load_json(validation_path)

profile_results: dict[str, dict] = {}

lucy_tools = lucy.get("platform_toolsets", {}).get("cli", [])
if not isinstance(lucy_tools, list):
    fail("Lucy CLI toolsets are invalid")
for forbidden in ("file", "terminal", "code_execution"):
    if forbidden in lucy_tools:
        fail(f"Lucy has forbidden toolset: {forbidden}")
for required in (
    "lucy-architect-read",
    "lucy-harness-control",
    "kanban",
):
    if required not in lucy_tools:
        fail(f"Lucy is missing required toolset: {required}")
profile_results["lucy"] = {
    "toolsets": lucy_tools,
    "forbidden_mutation_tools_absent": True,
}

xixi_tools = xixi.get("platform_toolsets", {}).get("cli", [])
xixi_terminal = xixi.get("terminal", {})
for required in ("file", "terminal", "kanban"):
    if required not in xixi_tools:
        fail(f"Xixi is missing required toolset: {required}")
if xixi_terminal.get("backend") != "docker":
    fail("Xixi terminal backend is not Docker")
if xixi_terminal.get("docker_network") is not False:
    fail("Xixi Docker network is not disabled")
if xixi_terminal.get("docker_mount_cwd_to_workspace") is not False:
    fail("Xixi automatically mounts its launch directory")
profile_results["xixi"] = {
    "toolsets": xixi_tools,
    "backend": "docker",
    "network": False,
}

lynn_tools = lynn.get("platform_toolsets", {}).get("cli", [])
lynn_terminal = lynn.get("terminal", {})
for required in ("file", "terminal", "kanban"):
    if required not in lynn_tools:
        fail(f"Lynn is missing required toolset: {required}")
if lynn_terminal.get("backend") != "docker":
    fail("Lynn terminal backend is not Docker")
if lynn_terminal.get("docker_network") is not False:
    fail("Lynn Docker network is not disabled")
volumes = lynn_terminal.get("docker_volumes", [])
if not any(
    isinstance(item, str) and item.endswith(":/reviews:ro")
    for item in volumes
):
    fail("Lynn review package is not mounted read-only")
profile_results["lynn"] = {
    "toolsets": lynn_tools,
    "backend": "docker",
    "network": False,
    "review_mount_read_only": True,
}

gemma_tools = gemma.get("platform_toolsets", {}).get("cli", [])
for forbidden in ("file", "terminal", "code_execution"):
    if forbidden in gemma_tools:
        fail(f"Gemma has forbidden toolset: {forbidden}")
profile_results["gemma"] = {
    "toolsets": gemma_tools,
    "source_mutation_tools_absent": True,
}

project_map = projects.get("projects")
if not isinstance(project_map, dict):
    fail("Project registry has no projects mapping")
project = project_map.get("xixi-smoke")
if not isinstance(project, dict):
    fail("xixi-smoke is not registered")

canonical = Path(project.get("root", "")).expanduser().resolve(strict=True)
workspace_root = Path(
    project.get("workspace_root", "")
).expanduser().resolve(strict=True)

if canonical == workspace_root:
    fail("Canonical root and workspace root are identical")
if project.get("workspace_mode") != "git-worktree":
    fail("Project workspace_mode is not git-worktree")
if project.get("apply_mode") != "validated-patch":
    fail("Project apply_mode is not validated-patch")
if project.get("require_clean_canonical") is not True:
    fail("Project does not require a clean canonical repository")
if project.get("tei_approval_required") is not True:
    fail("Project does not require Tei approval")

canonical_status = git(canonical, "status", "--porcelain")
if canonical_status:
    fail(f"Canonical repository is not clean: {canonical_status}")

applied_file = canonical / "xixi-created.txt"
if not applied_file.is_file():
    fail("Applied smoke file is missing from canonical repository")
if applied_file.read_text(encoding="utf-8").strip() != "XIXI_SANDBOX_WRITE_OK":
    fail("Applied smoke file content is invalid")

canonical_head = git(canonical, "rev-parse", "HEAD")
canonical_log = git(canonical, "log", "-1", "--pretty=%s")

expected_gates = {
    "contract_valid": True,
    "implementation_artifacts_valid": True,
    "review_accepted": True,
    "machine_validation_passed": True,
    "tei_approved": True,
    "applied": True,
}

gates = workflow.get("gates")
if not isinstance(gates, dict):
    fail("Workflow gates are missing")
for key, expected in expected_gates.items():
    actual = gates.get(key)
    if actual is not expected:
        fail(f"workflow.gates.{key}: expected {expected!r}, got {actual!r}")

if workflow.get("readiness") != "APPLIED":
    fail(
        f"Workflow readiness is not APPLIED: "
        f"{workflow.get('readiness')!r}"
    )

validation_checks = {
    "non_llm": True,
    "network": False,
    "scope_match": True,
    "passed": True,
}
for key, expected in validation_checks.items():
    actual = validation.get(key)
    if actual is not expected:
        fail(
            f"validation-report.{key}: expected "
            f"{expected!r}, got {actual!r}"
        )

commands = validation.get("commands")
if not isinstance(commands, list) or not commands:
    fail("Machine Validation command evidence is missing")
if not all(
    isinstance(item, dict) and item.get("passed") is True
    for item in commands
):
    fail("One or more Machine Validation commands did not pass")

report = {
    "version": 1,
    "verified_at": datetime.now(timezone.utc).isoformat(),
    "task_id": "TASK-SMOKE-001",
    "result": "PASS",
    "profiles": profile_results,
    "project": {
        "name": "xixi-smoke",
        "canonical_root": str(canonical),
        "workspace_root": str(workspace_root),
        "roots_separated": True,
        "workspace_mode": project.get("workspace_mode"),
        "apply_mode": project.get("apply_mode"),
        "canonical_clean": True,
        "canonical_head": canonical_head,
        "canonical_last_commit": canonical_log,
        "applied_file_verified": True,
    },
    "workflow": {
        "readiness": workflow.get("readiness"),
        "gates": gates,
    },
    "machine_validation": {
        "non_llm": True,
        "network": False,
        "scope_match": True,
        "passed": True,
    },
    "control_chain": [
        "Lucy architecture inspection",
        "immutable Task Contract",
        "Xixi Docker implementation",
        "Lynn clean-room review",
        "Evidence Gate",
        "Machine Validator",
        "Tei human approval",
        "deterministic canonical apply",
    ],
}

temporary = final_report_path.with_suffix(".json.tmp")
with temporary.open("w", encoding="utf-8") as stream:
    json.dump(
        report,
        stream,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    )
    stream.write("\n")
temporary.chmod(0o600)
temporary.replace(final_report_path)

print("Lucy least privilege: PASS")
print("Xixi Docker isolation: PASS")
print("Lynn clean-room isolation: PASS")
print("Gemma source isolation: PASS")
print("Canonical/workspace separation: PASS")
print("Contract Gate: PASS")
print("Evidence Gate: PASS")
print("Machine Validator: PASS")
print("Tei Approval Gate: PASS")
print("Canonical apply: PASS")
print("Canonical clean state: PASS")
print("Final report:", final_report_path)
PY

echo
echo "=== 4. Human approval status ==="

lucy-approval status "$TASK_ID"

echo
echo "=== 5. Final report ==="

cat "$FINAL_REPORT"

echo
echo "PASS: Hermes collaboration system end-to-end verification completed."
