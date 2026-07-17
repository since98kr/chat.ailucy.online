#!/usr/bin/env bash
set -Eeuo pipefail

HERMES_HOME="$HOME/.hermes"
HERMES_PY="$HERMES_HOME/hermes-agent/venv/bin/python"
PLUGIN_HOME="$HERMES_HOME/plugins/lucy-harness"
CONTROL_HOME="$HERMES_HOME/lucy-control"
APPROVAL_CLI="$HOME/.local/bin/lucy-approval"
BACKUP="$HOME/hermes-before-tei-approval-gate-$(date +%Y%m%d_%H%M%S)"

TASK_ID="TASK-SMOKE-001"

echo "=== 1. Preconditions ==="

test -x "$HERMES_PY" || {
  echo "FAIL: Hermes Python missing: $HERMES_PY"
  exit 1
}

test -f "$PLUGIN_HOME/gates.py" || {
  echo "FAIL: gates.py missing."
  exit 1
}

test -f "$PLUGIN_HOME/machine_validator.py" || {
  echo "FAIL: machine_validator.py missing."
  exit 1
}

test -f "$CONTROL_HOME/workflows/$TASK_ID.json" || {
  echo "FAIL: Workflow missing for $TASK_ID"
  exit 1
}

echo
 echo "=== 2. Backup ==="

mkdir -p "$BACKUP"
cp -a "$PLUGIN_HOME" "$BACKUP/lucy-harness-plugin"
cp -a "$CONTROL_HOME" "$BACKUP/lucy-control"

if [[ -e "$APPROVAL_CLI" ]]; then
  cp -a "$APPROVAL_CLI" "$BACKUP/lucy-approval"
fi

echo "Backup: $BACKUP"

echo
 echo "=== 3. Install human-only approval gate ==="

cat > "$PLUGIN_HOME/approval_gate.py" <<'PY'
"""Human-only Tei Approval, Apply, Status, and Rollback gate.

This module is intentionally not registered as a Hermes model tool.
Only the local CLI wrapper exposes it to the authenticated server user.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys

import yaml


def _load_local_module(filename: str, module_name: str):
    spec = importlib.util.spec_from_file_location(
        module_name,
        Path(__file__).with_name(filename),
    )

    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {filename}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gates = _load_local_module(
    "gates.py",
    "lucy_harness_gates_approval",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def _run(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: int = 300,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )

    if check and completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip()
            or completed.stdout.strip()
            or f"Command failed: {command!r}"
        )

    return completed


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")

    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(
            payload,
            stream,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
        stream.write("\n")

    os.chmod(temporary, 0o600)
    temporary.replace(path)


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise FileNotFoundError(f"Required JSON file missing: {path}")

    with path.open("r", encoding="utf-8") as stream:
        data = json.load(stream)

    if not isinstance(data, dict):
        raise ValueError(f"JSON root must be an object: {path}")

    return data


def _approval_dir() -> Path:
    return gates._control() / "approvals"


def _approval_path(task_id: str) -> Path:
    return _approval_dir() / f"{task_id}.json"


def _apply_root(task_id: str) -> Path:
    return gates._control() / "apply-runs" / task_id


def _project(task_id: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
    contract = gates._load_contract(task_id)

    with gates._registry_path().open(
        "r",
        encoding="utf-8",
    ) as stream:
        registry = yaml.safe_load(stream) or {}

    projects = registry.get("projects")

    if not isinstance(projects, dict):
        raise ValueError("projects.yaml has no projects mapping")

    project = projects.get(contract["project"])

    if not isinstance(project, dict):
        raise ValueError(
            f"Registered project missing: {contract['project']}"
        )

    if project.get("enabled", True) is not True:
        raise PermissionError("Project is disabled")

    if project.get("apply_mode") != "validated-patch":
        raise PermissionError(
            "Project apply_mode must be validated-patch"
        )

    if project.get("require_clean_canonical") is not True:
        raise PermissionError(
            "Project must require a clean canonical repository"
        )

    if project.get("tei_approval_required") is not True:
        raise PermissionError(
            "Project must require explicit Tei approval"
        )

    root_text = project.get("root")

    if not isinstance(root_text, str) or not root_text.strip():
        raise ValueError("Project root is invalid")

    canonical = Path(
        os.path.expandvars(os.path.expanduser(root_text))
    ).resolve(strict=True)

    allowed_root = (Path.home() / "hermes-projects").resolve()

    try:
        canonical.relative_to(allowed_root)
    except ValueError as exc:
        raise PermissionError(
            f"Canonical root must be under {allowed_root}"
        ) from exc

    if not (canonical / ".git").exists():
        raise ValueError(
            f"Canonical root is not a Git repository: {canonical}"
        )

    return contract, project, canonical


def _git_head(root: Path) -> str:
    return _run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
    ).stdout.strip()


def _git_clean(root: Path) -> bool:
    return not _run(
        ["git", "status", "--porcelain"],
        cwd=root,
    ).stdout.strip()


def _artifact_hashes(task_id: str) -> dict[str, str]:
    artifact_dir = gates._artifact_dir(task_id)

    if not artifact_dir.is_dir() or artifact_dir.is_symlink():
        raise FileNotFoundError(
            f"Artifact directory missing: {artifact_dir}"
        )

    hashes: dict[str, str] = {}

    for path in sorted(artifact_dir.iterdir()):
        if path.is_symlink():
            raise PermissionError(
                f"Symbolic-link artifact rejected: {path.name}"
            )

        if path.is_file():
            hashes[path.name] = _sha256(path)

    if "validation-report.json" not in hashes:
        raise FileNotFoundError(
            "validation-report.json is required before approval"
        )

    return hashes


def _load_workflow(task_id: str) -> tuple[Path, dict[str, Any]]:
    path = gates._workflow_path(task_id)
    return path, _load_json(path)


def _save_workflow(
    path: Path,
    workflow: dict[str, Any],
) -> None:
    workflow["updated_at"] = _now()
    _atomic_json(path, workflow)


def _validation_report(task_id: str) -> dict[str, Any]:
    return _load_json(
        gates._artifact_dir(task_id)
        / "validation-report.json"
    )


def _declared_changed_files(task_id: str) -> list[str]:
    payload = _load_json(
        gates._artifact_dir(task_id)
        / "changed-files.json"
    )

    raw = payload.get("changed_files")

    if not isinstance(raw, list) or not raw:
        raise ValueError(
            "changed-files.json must contain a non-empty changed_files list"
        )

    result = [gates._safe_relative_file(item) for item in raw]

    if len(set(result)) != len(result):
        raise ValueError("changed_files contains duplicates")

    return sorted(result)


def _actual_changed_files(root: Path) -> list[str]:
    tracked = _run(
        [
            "git",
            "diff",
            "--name-only",
            "--diff-filter=ACDMRTUXB",
            "HEAD",
        ],
        cwd=root,
    ).stdout.splitlines()

    untracked = _run(
        [
            "git",
            "ls-files",
            "--others",
            "--exclude-standard",
        ],
        cwd=root,
    ).stdout.splitlines()

    return sorted(set(filter(None, tracked + untracked)))


def _docker_base(
    project: dict[str, Any],
    workspace: Path,
) -> tuple[list[str], int]:
    validation = project.get("validation")

    if not isinstance(validation, dict):
        raise ValueError("Project validation policy is missing")

    image = validation.get("image")

    if not isinstance(image, str) or not image.strip():
        raise ValueError("validation.image is missing")

    cpu = float(validation.get("cpu", 1))
    memory_mb = int(validation.get("memory_mb", 1024))
    timeout = int(validation.get("timeout_seconds", 300))

    if not 0 < cpu <= 4:
        raise ValueError("validation.cpu must be > 0 and <= 4")

    if not 256 <= memory_mb <= 8192:
        raise ValueError(
            "validation.memory_mb must be between 256 and 8192"
        )

    if not 1 <= timeout <= 1800:
        raise ValueError(
            "validation.timeout_seconds must be between 1 and 1800"
        )

    command = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--cpus",
        str(cpu),
        "--memory",
        f"{memory_mb}m",
        "--pids-limit",
        "256",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "-e",
        "CI=true",
        "-e",
        "HOME=/tmp",
        "-v",
        f"{workspace}:/workspace",
        "-w",
        "/workspace",
        image.strip(),
    ]

    return command, timeout


def _rollback_to(root: Path, head: str) -> None:
    _run(
        ["git", "reset", "--hard", head],
        cwd=root,
        timeout=120,
    )

    _run(
        ["git", "clean", "-fdx"],
        cwd=root,
        timeout=120,
    )


def approve(task_id_value: Any, confirm: str) -> dict[str, Any]:
    task_id = gates._safe_task_id(task_id_value)
    expected_confirmation = f"APPROVE {task_id}"

    if confirm != expected_confirmation:
        raise PermissionError(
            f"Confirmation must exactly equal: {expected_confirmation}"
        )

    status = gates.workflow_status_data(task_id)

    if status.get("ready_for_tei") is not True:
        raise PermissionError(
            "Task is not READY_FOR_TEI"
        )

    workflow_path, workflow = _load_workflow(task_id)
    gate_state = workflow.setdefault("gates", {})

    if gate_state.get("applied") is True:
        raise PermissionError("Task is already applied")

    contract, project, canonical = _project(task_id)

    if not _git_clean(canonical):
        raise PermissionError(
            "Canonical repository is not clean"
        )

    validation = _validation_report(task_id)

    if validation.get("passed") is not True:
        raise PermissionError(
            "Machine Validation report is not passing"
        )

    canonical_head = _git_head(canonical)
    validated_head = validation.get("project_head")

    if canonical_head != validated_head:
        raise PermissionError(
            "Canonical HEAD differs from the validated HEAD"
        )

    approval_path = _approval_path(task_id)

    if approval_path.exists():
        existing = _load_json(approval_path)

        if existing.get("revoked") is not True:
            raise FileExistsError(
                f"Active approval already exists: {approval_path}"
            )

    record = {
        "version": 1,
        "task_id": task_id,
        "project": contract["project"],
        "approver": "tei",
        "approved_at": _now(),
        "confirmation": expected_confirmation,
        "canonical_root": str(canonical),
        "canonical_head": canonical_head,
        "contract_sha256": _sha256(
            gates._contract_path(task_id)
        ),
        "artifact_hashes": _artifact_hashes(task_id),
        "validation_passed": True,
        "changed_files": _declared_changed_files(task_id),
        "revoked": False,
        "applied": False,
    }

    _atomic_json(approval_path, record)

    gate_state["tei_approved"] = True
    workflow["approval_record"] = str(approval_path)
    workflow["approval_record_sha256"] = _sha256(approval_path)
    workflow["readiness"] = "APPROVED_FOR_APPLY"
    _save_workflow(workflow_path, workflow)

    gates._audit(
        "tei_approve",
        task_id,
        True,
        {
            "canonical_head": canonical_head,
            "approval_record": str(approval_path),
        },
    )

    return {
        "success": True,
        "task_id": task_id,
        "readiness": "APPROVED_FOR_APPLY",
        "tei_approved": True,
        "applied": False,
        "approval_record": str(approval_path),
        "canonical_head": canonical_head,
    }


def _verify_approval_freeze(
    task_id: str,
    approval: dict[str, Any],
    canonical: Path,
) -> None:
    if approval.get("task_id") != task_id:
        raise PermissionError("Approval task_id mismatch")

    if approval.get("approver") != "tei":
        raise PermissionError("Approval approver must be tei")

    if approval.get("revoked") is True:
        raise PermissionError("Approval has been revoked")

    if approval.get("applied") is True:
        raise PermissionError("Approval has already been applied")

    if approval.get("canonical_root") != str(canonical):
        raise PermissionError("Canonical root changed after approval")

    if approval.get("canonical_head") != _git_head(canonical):
        raise PermissionError("Canonical HEAD changed after approval")

    if approval.get("contract_sha256") != _sha256(
        gates._contract_path(task_id)
    ):
        raise PermissionError("Task Contract changed after approval")

    current_hashes = _artifact_hashes(task_id)

    if approval.get("artifact_hashes") != current_hashes:
        raise PermissionError("Evidence artifacts changed after approval")


def apply(task_id_value: Any, confirm: str) -> dict[str, Any]:
    task_id = gates._safe_task_id(task_id_value)
    expected_confirmation = f"APPLY {task_id}"

    if confirm != expected_confirmation:
        raise PermissionError(
            f"Confirmation must exactly equal: {expected_confirmation}"
        )

    workflow_path, workflow = _load_workflow(task_id)
    gate_state = workflow.setdefault("gates", {})

    if gate_state.get("tei_approved") is not True:
        raise PermissionError("Tei approval is missing")

    if gate_state.get("applied") is True:
        raise PermissionError("Task is already applied")

    contract, project, canonical = _project(task_id)

    if not _git_clean(canonical):
        raise PermissionError("Canonical repository is not clean")

    approval_path = _approval_path(task_id)
    approval = _load_json(approval_path)
    _verify_approval_freeze(task_id, approval, canonical)

    pre_apply_head = approval["canonical_head"]
    artifact_dir = gates._artifact_dir(task_id)
    patch_path = artifact_dir / "patch.diff"
    changed_files = _declared_changed_files(task_id)
    allowed_files = sorted(
        gates._safe_relative_file(item)
        for item in contract["scope"]["allowed_files"]
    )

    outside = sorted(set(changed_files) - set(allowed_files))

    if outside:
        raise PermissionError(
            "Changed files outside Task Contract scope: "
            + ", ".join(outside)
        )

    stamp = datetime.now(timezone.utc).strftime(
        "%Y%m%dT%H%M%S%fZ"
    )
    run_root = _apply_root(task_id) / stamp
    validation_workspace = run_root / "validation-workspace"
    run_root.mkdir(parents=True, exist_ok=False)
    os.chmod(run_root, 0o700)

    apply_report: dict[str, Any] = {
        "version": 1,
        "task_id": task_id,
        "started_at": _now(),
        "pre_apply_head": pre_apply_head,
        "canonical_root": str(canonical),
        "changed_files": changed_files,
        "commands": [],
        "passed": False,
        "rolled_back": False,
    }

    report_path = run_root / "apply-report.json"

    try:
        docker_base, timeout = _docker_base(project, canonical)
        patch_command = docker_base[:-1] + [
            "-v",
            f"{artifact_dir}:/input:ro",
            docker_base[-1],
            "sh",
            "-lc",
            (
                "set -eu; "
                "patch --batch --forward "
                "--reject-file=- -p1 < /input/patch.diff"
            ),
        ]

        patch_result = _run(
            patch_command,
            timeout=timeout,
            check=False,
        )

        apply_report["patch_apply"] = {
            "exit_code": patch_result.returncode,
            "stdout": patch_result.stdout[-200000:],
            "stderr": patch_result.stderr[-200000:],
        }

        if patch_result.returncode != 0:
            raise RuntimeError(
                patch_result.stderr.strip()
                or patch_result.stdout.strip()
                or "Patch application failed"
            )

        actual_changed = _actual_changed_files(canonical)
        apply_report["actual_changed_files"] = actual_changed

        if actual_changed != changed_files:
            raise RuntimeError(
                "Applied patch scope mismatch. "
                f"declared={changed_files!r}, actual={actual_changed!r}"
            )

        shutil.copytree(
            canonical,
            validation_workspace,
            symlinks=True,
            ignore=shutil.ignore_patterns(".git"),
        )

        validation = project.get("validation") or {}
        allowed_commands = validation.get("allowed_commands")
        commands = contract["validation"]["commands"]

        if not isinstance(allowed_commands, list):
            raise ValueError("Project validation allowlist is missing")

        rejected = [
            command
            for command in commands
            if command not in allowed_commands
        ]

        if rejected:
            raise PermissionError(
                "Validation command is not allowlisted: "
                + " | ".join(rejected)
            )

        for command_text in commands:
            command_base, timeout = _docker_base(
                project,
                validation_workspace,
            )
            result = _run(
                command_base + ["sh", "-lc", command_text],
                timeout=timeout,
                check=False,
            )

            record = {
                "command": command_text,
                "exit_code": result.returncode,
                "stdout": result.stdout[-200000:],
                "stderr": result.stderr[-200000:],
                "passed": result.returncode == 0,
            }
            apply_report["commands"].append(record)

            if result.returncode != 0:
                raise RuntimeError(
                    f"Post-apply validation failed: {command_text}"
                )

        if _actual_changed_files(canonical) != changed_files:
            raise RuntimeError(
                "Canonical scope changed during post-apply validation"
            )

        _run(
            ["git", "add", "--all", "--", *changed_files],
            cwd=canonical,
        )

        commit_result = _run(
            [
                "git",
                "-c",
                "user.name=Lucy Harness",
                "-c",
                "user.email=lucy-harness@local.invalid",
                "commit",
                "-m",
                f"Apply {task_id}",
                "--",
                *changed_files,
            ],
            cwd=canonical,
        )

        applied_commit = _git_head(canonical)

        if not _git_clean(canonical):
            raise RuntimeError(
                "Canonical repository is not clean after commit"
            )

        apply_report.update({
            "completed_at": _now(),
            "passed": True,
            "applied_commit": applied_commit,
            "commit_stdout": commit_result.stdout[-200000:],
        })
        _atomic_json(report_path, apply_report)

        approval["applied"] = True
        approval["applied_at"] = _now()
        approval["applied_commit"] = applied_commit
        approval["apply_report"] = str(report_path)
        _atomic_json(approval_path, approval)

        gate_state["applied"] = True
        workflow["readiness"] = "APPLIED"
        workflow["pre_apply_head"] = pre_apply_head
        workflow["applied_commit"] = applied_commit
        workflow["apply_report"] = str(report_path)
        _save_workflow(workflow_path, workflow)

        gates._audit(
            "tei_apply",
            task_id,
            True,
            {
                "pre_apply_head": pre_apply_head,
                "applied_commit": applied_commit,
                "apply_report": str(report_path),
            },
        )

        return {
            "success": True,
            "task_id": task_id,
            "readiness": "APPLIED",
            "tei_approved": True,
            "applied": True,
            "pre_apply_head": pre_apply_head,
            "applied_commit": applied_commit,
            "apply_report": str(report_path),
        }

    except Exception as exc:
        _rollback_to(canonical, pre_apply_head)
        apply_report.update({
            "completed_at": _now(),
            "passed": False,
            "rolled_back": True,
            "error": str(exc),
        })
        _atomic_json(report_path, apply_report)

        gate_state["applied"] = False
        workflow["readiness"] = "APPLY_FAILED_ROLLED_BACK"
        workflow["apply_report"] = str(report_path)
        workflow["apply_error"] = str(exc)
        _save_workflow(workflow_path, workflow)

        gates._audit(
            "tei_apply",
            task_id,
            False,
            {
                "error": str(exc),
                "rolled_back_to": pre_apply_head,
                "apply_report": str(report_path),
            },
        )
        raise


def rollback(task_id_value: Any, confirm: str) -> dict[str, Any]:
    task_id = gates._safe_task_id(task_id_value)
    expected_confirmation = f"ROLLBACK {task_id}"

    if confirm != expected_confirmation:
        raise PermissionError(
            f"Confirmation must exactly equal: {expected_confirmation}"
        )

    workflow_path, workflow = _load_workflow(task_id)
    gate_state = workflow.setdefault("gates", {})

    if gate_state.get("applied") is not True:
        raise PermissionError("Task is not currently applied")

    _, _, canonical = _project(task_id)
    approval_path = _approval_path(task_id)
    approval = _load_json(approval_path)

    applied_commit = approval.get("applied_commit")
    pre_apply_head = approval.get("canonical_head")

    if not isinstance(applied_commit, str) or not applied_commit:
        raise ValueError("Approval record has no applied_commit")

    if not isinstance(pre_apply_head, str) or not pre_apply_head:
        raise ValueError("Approval record has no canonical_head")

    if _git_head(canonical) != applied_commit:
        raise PermissionError(
            "Canonical HEAD has advanced since Harness apply; "
            "automatic rollback is refused"
        )

    if not _git_clean(canonical):
        raise PermissionError(
            "Canonical repository is not clean; automatic rollback refused"
        )

    _rollback_to(canonical, pre_apply_head)

    approval["revoked"] = True
    approval["rollback_at"] = _now()
    approval["rolled_back_to"] = pre_apply_head
    _atomic_json(approval_path, approval)

    gate_state["tei_approved"] = False
    gate_state["applied"] = False
    workflow["readiness"] = "ROLLED_BACK"
    workflow["rolled_back_to"] = pre_apply_head
    _save_workflow(workflow_path, workflow)

    gates._audit(
        "tei_rollback",
        task_id,
        True,
        {
            "rolled_back_from": applied_commit,
            "rolled_back_to": pre_apply_head,
        },
    )

    return {
        "success": True,
        "task_id": task_id,
        "readiness": "ROLLED_BACK",
        "tei_approved": False,
        "applied": False,
        "rolled_back_from": applied_commit,
        "rolled_back_to": pre_apply_head,
    }


def status(task_id_value: Any) -> dict[str, Any]:
    task_id = gates._safe_task_id(task_id_value)
    workflow_path, workflow = _load_workflow(task_id)
    approval_path = _approval_path(task_id)
    approval = (
        _load_json(approval_path)
        if approval_path.is_file()
        else None
    )

    _, _, canonical = _project(task_id)

    return {
        "success": True,
        "task_id": task_id,
        "workflow_path": str(workflow_path),
        "readiness": workflow.get("readiness"),
        "gates": workflow.get("gates", {}),
        "canonical_root": str(canonical),
        "canonical_head": _git_head(canonical),
        "canonical_clean": _git_clean(canonical),
        "approval_record": (
            str(approval_path) if approval is not None else None
        ),
        "approval": approval,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="lucy-approval",
        description=(
            "Human-only Tei Approval, deterministic Apply, and Rollback gate"
        ),
    )

    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
    )

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("task_id")

    approve_parser = subparsers.add_parser("approve")
    approve_parser.add_argument("task_id")
    approve_parser.add_argument("--confirm", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("task_id")
    apply_parser.add_argument("--confirm", required=True)

    rollback_parser = subparsers.add_parser("rollback")
    rollback_parser.add_argument("task_id")
    rollback_parser.add_argument("--confirm", required=True)

    arguments = parser.parse_args()

    try:
        if arguments.command == "status":
            result = status(arguments.task_id)
        elif arguments.command == "approve":
            result = approve(
                arguments.task_id,
                arguments.confirm,
            )
        elif arguments.command == "apply":
            result = apply(
                arguments.task_id,
                arguments.confirm,
            )
        elif arguments.command == "rollback":
            result = rollback(
                arguments.task_id,
                arguments.confirm,
            )
        else:
            parser.error("Unknown command")
            return 2

        print(json.dumps(
            result,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ))
        return 0 if result.get("success") else 1

    except Exception as exc:
        print(json.dumps(
            {
                "success": False,
                "error": str(exc),
            },
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        ))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
PY

chmod 600 "$PLUGIN_HOME/approval_gate.py"

cat > "$APPROVAL_CLI" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail

exec "$HERMES_PY" \
  "$PLUGIN_HOME/approval_gate.py" \
  "\$@"
EOF

chmod 700 "$APPROVAL_CLI"

mkdir -p \
  "$CONTROL_HOME/approvals" \
  "$CONTROL_HOME/apply-runs"

chmod 700 \
  "$CONTROL_HOME/approvals" \
  "$CONTROL_HOME/apply-runs"

echo
 echo "=== 4. Compile ==="

"$HERMES_PY" -m py_compile \
  "$PLUGIN_HOME/approval_gate.py"

echo
 echo "=== 5. Confirm approval/apply are not Hermes model tools ==="

TOOLS_OUTPUT="$(lucy tools --summary 2>/dev/null || true)"

if printf '%s\n' "$TOOLS_OUTPUT" | grep -Eq \
  'tei_approve|tei_apply|approval_gate|lucy-approval'
then
  echo "FAIL: Human-only approval functions leaked into Lucy tools."
  exit 1
fi

echo "Approval and Apply are not exposed to Lucy: PASS"

echo
 echo "=== 6. Verify current task status ==="

"$APPROVAL_CLI" status "$TASK_ID"

echo
 echo "PASS: Human-only Tei Approval Gate installed."
echo
echo "Next explicit human commands:"
echo "  lucy-approval approve $TASK_ID --confirm 'APPROVE $TASK_ID'"
echo "  lucy-approval apply   $TASK_ID --confirm 'APPLY $TASK_ID'"
