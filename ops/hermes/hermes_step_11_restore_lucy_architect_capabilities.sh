#!/usr/bin/env bash
set -Eeuo pipefail

HERMES_HOME="$HOME/.hermes"
HERMES_PY="$HERMES_HOME/hermes-agent/venv/bin/python"
PLUGIN_HOME="$HERMES_HOME/plugins/lucy-harness"
CONTROL_HOME="$HERMES_HOME/lucy-control"
CONFIG_FILE="$HERMES_HOME/config.yaml"
SOUL_FILE="$HERMES_HOME/SOUL.md"
SKILL_FILE="$HERMES_HOME/skills/lucy-architect/SKILL.md"
BACKUP="$HOME/hermes-before-lucy-host-tools-$(date +%Y%m%d_%H%M%S)"

echo "=== 1. Preconditions ==="

test -x "$HERMES_PY" || { echo "FAIL: Hermes Python missing: $HERMES_PY"; exit 1; }
test -f "$PLUGIN_HOME/__init__.py" || { echo "FAIL: Lucy Harness plugin missing."; exit 1; }
test -f "$PLUGIN_HOME/plugin.yaml" || { echo "FAIL: Plugin manifest missing."; exit 1; }
test -f "$CONFIG_FILE" || { echo "FAIL: Lucy config missing."; exit 1; }
test -f "$CONTROL_HOME/projects.yaml" || { echo "FAIL: Project registry missing."; exit 1; }

echo
echo "=== 2. Backup ==="

mkdir -p "$BACKUP"
cp -a "$PLUGIN_HOME" "$BACKUP/lucy-harness-plugin"
cp -a "$CONFIG_FILE" "$BACKUP/config.yaml"
cp -a "$CONTROL_HOME/projects.yaml" "$BACKUP/projects.yaml"
[[ -f "$SOUL_FILE" ]] && cp -a "$SOUL_FILE" "$BACKUP/SOUL.md"
[[ -f "$SKILL_FILE" ]] && cp -a "$SKILL_FILE" "$BACKUP/lucy-architect-SKILL.md"

echo "Backup: $BACKUP"

echo
echo "=== 3. Install host-access policy ==="

cat > "$CONTROL_HOME/host-access.yaml" <<'YAML'
version: 1

allowed_roots:
  - /home/since98kr
  - /opt
  - /srv
  - /data

scan:
  max_depth: 6
  max_results: 300

read:
  max_bytes: 524288
  max_lines: 400

denied_path_names:
  - .ssh
  - .gnupg
  - .aws
  - .kube
  - .docker
  - .npm
  - .cache
  - node_modules
  - .venv
  - venv
  - __pycache__
  - .git/objects
  - secrets
  - secret
  - credentials
  - private

denied_file_globs:
  - .env
  - .env.*
  - '*.pem'
  - '*.key'
  - '*.p12'
  - '*.pfx'
  - '*.kdbx'
  - id_rsa
  - id_ed25519
  - credentials.json
  - service-account*.json
  - '*secret*'
  - '*token*'
  - '*.sqlite'
  - '*.db'
  - '*.dump'
YAML

chmod 600 "$CONTROL_HOME/host-access.yaml"

echo
echo "=== 4. Install host tool schemas ==="

cat > "$PLUGIN_HOME/host_schemas.py" <<'PY'
"""Controlled host-inspection schemas for Lucy."""

HOST_OVERVIEW = {
    "name": "host_overview",
    "description": (
        "Return a read-only overview of the Hermes host: hostname, OS, user, "
        "configured inspection roots, disk usage, and basic runtime presence. "
        "It does not expose environment variables or secret files."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

SERVICE_OVERVIEW = {
    "name": "service_overview",
    "description": (
        "Inspect running Docker containers and active systemd services using "
        "fixed read-only commands. No arbitrary shell command is accepted."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "include_systemd": {
                "type": "boolean",
                "default": True,
            },
            "include_docker": {
                "type": "boolean",
                "default": True,
            },
        },
        "additionalProperties": False,
    },
}

REPOSITORY_DISCOVER = {
    "name": "repository_discover",
    "description": (
        "Discover Git repositories and likely service roots beneath the "
        "configured host allowlist. Use this when a project is not yet in "
        "the Lucy project registry. Secret and dependency directories are pruned."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Optional case-insensitive path/name filter.",
                "default": "",
            },
            "max_depth": {
                "type": "integer",
                "minimum": 1,
                "maximum": 8,
                "default": 5,
            },
            "max_results": {
                "type": "integer",
                "minimum": 1,
                "maximum": 300,
                "default": 100,
            },
        },
        "additionalProperties": False,
    },
}

REPOSITORY_INSPECT = {
    "name": "repository_inspect",
    "description": (
        "Inspect one discovered Git repository using fixed read-only Git commands. "
        "Returns branch, HEAD, status, redacted remotes, manifests, and top-level files."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute repository path returned by repository_discover.",
            }
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}

HOST_FILE_READ = {
    "name": "host_file_read",
    "description": (
        "Read a bounded UTF-8 text range beneath configured host roots before a "
        "project is registered. Secret filenames, symlinks, binary files, and path "
        "escapes are rejected; likely credential assignments are redacted."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute text-file path beneath an allowed root.",
            },
            "start_line": {
                "type": "integer",
                "minimum": 1,
                "default": 1,
            },
            "max_lines": {
                "type": "integer",
                "minimum": 1,
                "maximum": 400,
                "default": 200,
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}

PROJECT_REGISTER_READONLY = {
    "name": "project_register_readonly",
    "description": (
        "Register a discovered Git repository for Lucy's read-only Architect tools. "
        "This changes only the Lucy project registry; it does not modify project files "
        "and does not grant Xixi or Lynn access."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Stable registry name using letters, digits, dot, hyphen or underscore.",
            },
            "path": {
                "type": "string",
                "description": "Absolute Git repository root returned by repository_discover.",
            },
            "description": {
                "type": "string",
                "default": "",
            },
        },
        "required": ["name", "path"],
        "additionalProperties": False,
    },
}
PY

echo
echo "=== 5. Install controlled host handlers ==="

cat > "$PLUGIN_HOME/host_tools.py" <<'PY'
"""Controlled, read-mostly host inspection for Lucy."""

from __future__ import annotations

from datetime import datetime, timezone
from fnmatch import fnmatch
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
import getpass
import json
import os
import re
import shutil
import socket
import subprocess

import yaml

try:
    from hermes_constants import get_hermes_home
except ImportError:
    def get_hermes_home() -> str:
        return str(Path.home() / ".hermes")


def _home() -> Path:
    return Path(get_hermes_home()).resolve()


def _control() -> Path:
    return _home() / "lucy-control"


def _policy_path() -> Path:
    return _control() / "host-access.yaml"


def _registry_path() -> Path:
    return _control() / "projects.yaml"


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _audit(tool: str, args: dict[str, Any], success: bool, error: str | None = None) -> None:
    try:
        path = _control() / "audit" / "host-tools.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool": tool,
            "path": args.get("path"),
            "query": args.get("query"),
            "name": args.get("name"),
            "success": success,
            "error": error,
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _ok(tool: str, args: dict[str, Any], **payload: Any) -> str:
    _audit(tool, args, True)
    return _json({"success": True, **payload})


def _fail(tool: str, args: dict[str, Any], exc: Exception | str) -> str:
    text = str(exc)
    _audit(tool, args, False, text)
    return _json({"success": False, "error": text})


def _load_policy() -> dict[str, Any]:
    with _policy_path().open("r", encoding="utf-8") as stream:
        policy = yaml.safe_load(stream) or {}
    if not isinstance(policy, dict):
        raise ValueError("host-access.yaml root must be a mapping")
    return policy


def _roots(policy: dict[str, Any]) -> list[Path]:
    raw = policy.get("allowed_roots", [])
    if not isinstance(raw, list):
        raise ValueError("allowed_roots must be a list")
    roots = []
    for item in raw:
        if not isinstance(item, str):
            continue
        path = Path(os.path.expandvars(os.path.expanduser(item))).resolve(strict=False)
        if path.is_dir():
            roots.append(path)
    if not roots:
        raise ValueError("No configured host roots are accessible")
    return roots


def _denied_names(policy: dict[str, Any]) -> set[str]:
    values = policy.get("denied_path_names", [])
    return {str(item) for item in values if isinstance(item, str)}


def _denied_globs(policy: dict[str, Any]) -> list[str]:
    values = policy.get("denied_file_globs", [])
    return [str(item) for item in values if isinstance(item, str)]


def _under_root(path: Path, roots: list[Path]) -> bool:
    for root in roots:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _check_allowed(path_text: Any, *, file: bool = False, directory: bool = False) -> tuple[Path, dict[str, Any]]:
    if not isinstance(path_text, str) or not path_text.strip():
        raise ValueError("An absolute host path is required")
    raw = Path(os.path.expandvars(os.path.expanduser(path_text.strip())))
    if not raw.is_absolute():
        raise PermissionError("Host-inspection paths must be absolute")
    if raw.is_symlink():
        raise PermissionError("Symbolic links are not allowed")
    path = raw.resolve(strict=True)
    policy = _load_policy()
    roots = _roots(policy)
    if not _under_root(path, roots):
        raise PermissionError("Path is outside configured inspection roots")
    denied = _denied_names(policy)
    for part in path.parts:
        if part in denied:
            raise PermissionError(f"Denied path component: {part}")
    if file and not path.is_file():
        raise FileNotFoundError(f"Not a regular file: {path}")
    if directory and not path.is_dir():
        raise NotADirectoryError(f"Not a directory: {path}")
    return path, policy


def _run(command: list[str], timeout: int = 15) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"},
        )
        return {
            "exit_code": completed.returncode,
            "stdout": completed.stdout[-200000:],
            "stderr": completed.stderr[-50000:],
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "exit_code": None,
            "stdout": (exc.stdout or "")[-200000:] if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "")[-50000:] if isinstance(exc.stderr, str) else "",
            "timed_out": True,
        }


def _redact_remote(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.hostname:
            host = parsed.hostname
            if parsed.port:
                host = f"{host}:{parsed.port}"
            return urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))
    except Exception:
        pass
    return re.sub(r"//[^/@\s]+@", "//[REDACTED]@", value)


def host_overview(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "host_overview"
    try:
        policy = _load_policy()
        roots = _roots(policy)
        os_release: dict[str, str] = {}
        release_path = Path("/etc/os-release")
        if release_path.is_file():
            for line in release_path.read_text(encoding="utf-8", errors="replace").splitlines():
                if "=" in line:
                    key, value = line.split("=", 1)
                    os_release[key] = value.strip().strip('"')
        disks = []
        for root in roots:
            usage = shutil.disk_usage(root)
            disks.append({
                "root": str(root),
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
            })
        return _ok(
            tool,
            args,
            hostname=socket.gethostname(),
            user=getpass.getuser(),
            os={
                "name": os_release.get("PRETTY_NAME") or os_release.get("NAME"),
                "id": os_release.get("ID"),
                "version": os_release.get("VERSION_ID"),
            },
            inspection_roots=[str(item) for item in roots],
            disks=disks,
            docker_cli=shutil.which("docker") is not None,
            systemctl=shutil.which("systemctl") is not None,
            git=shutil.which("git") is not None,
        )
    except Exception as exc:
        return _fail(tool, args, exc)


def service_overview(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "service_overview"
    try:
        payload: dict[str, Any] = {}
        if args.get("include_docker", True):
            if shutil.which("docker"):
                result = _run([
                    "docker", "ps", "--no-trunc",
                    "--format", "{{json .}}",
                ], 20)
                containers = []
                if result["exit_code"] == 0:
                    for line in result["stdout"].splitlines()[:200]:
                        try:
                            containers.append(json.loads(line))
                        except json.JSONDecodeError:
                            containers.append({"raw": line})
                payload["docker"] = {
                    "available": True,
                    "exit_code": result["exit_code"],
                    "containers": containers,
                    "error": result["stderr"].strip() or None,
                }
            else:
                payload["docker"] = {"available": False}
        if args.get("include_systemd", True):
            if shutil.which("systemctl"):
                result = _run([
                    "systemctl", "list-units", "--type=service",
                    "--state=running", "--no-pager", "--no-legend",
                ], 20)
                payload["systemd"] = {
                    "available": True,
                    "exit_code": result["exit_code"],
                    "services": result["stdout"].splitlines()[:300],
                    "error": result["stderr"].strip() or None,
                }
            else:
                payload["systemd"] = {"available": False}
        return _ok(tool, args, **payload)
    except Exception as exc:
        return _fail(tool, args, exc)


def repository_discover(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "repository_discover"
    try:
        policy = _load_policy()
        roots = _roots(policy)
        denied = _denied_names(policy)
        query = str(args.get("query", "")).strip().lower()
        configured_depth = int(policy.get("scan", {}).get("max_depth", 6))
        configured_results = int(policy.get("scan", {}).get("max_results", 300))
        max_depth = min(max(1, int(args.get("max_depth", 5))), configured_depth, 8)
        max_results = min(max(1, int(args.get("max_results", 100))), configured_results, 300)
        noisy = {
            ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache",
            "dist", "build", "coverage", ".next", "vendor", "target",
            "immich-app", "library", "uploads", "thumbnails",
        }
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for root in roots:
            root_depth = len(root.parts)
            for current_text, directories, files in os.walk(root, followlinks=False):
                current = Path(current_text)
                depth = len(current.parts) - root_depth
                kept = []
                for name in sorted(directories):
                    candidate = current / name
                    if name in noisy or name in denied or candidate.is_symlink():
                        continue
                    kept.append(name)
                directories[:] = kept if depth < max_depth else []
                is_git = (current / ".git").is_dir() or (current / ".git").is_file()
                manifests = sorted(set(files) & {
                    "package.json", "pyproject.toml", "requirements.txt", "go.mod",
                    "Cargo.toml", "pom.xml", "build.gradle", "Dockerfile",
                    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
                })
                if not is_git and not manifests:
                    continue
                text = str(current)
                if query and query not in text.lower() and query not in current.name.lower():
                    continue
                if text in seen:
                    continue
                seen.add(text)
                results.append({
                    "path": text,
                    "name": current.name,
                    "git_repository": is_git,
                    "manifests": manifests,
                })
                if len(results) >= max_results:
                    return _ok(tool, args, repositories=results, count=len(results), truncated=True)
        return _ok(tool, args, repositories=results, count=len(results), truncated=False)
    except Exception as exc:
        return _fail(tool, args, exc)


def repository_inspect(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "repository_inspect"
    try:
        path, _ = _check_allowed(args.get("path"), directory=True)
        top = _run(["git", "-C", str(path), "rev-parse", "--show-toplevel"])
        if top["exit_code"] != 0:
            raise ValueError(top["stderr"].strip() or "Not a Git repository")
        root = Path(top["stdout"].strip()).resolve(strict=True)
        _check_allowed(str(root), directory=True)
        branch = _run(["git", "-C", str(root), "branch", "--show-current"])
        head = _run(["git", "-C", str(root), "rev-parse", "HEAD"])
        status = _run(["git", "-C", str(root), "status", "--short", "--branch"])
        remotes_result = _run(["git", "-C", str(root), "remote", "-v"])
        remotes = []
        for line in remotes_result["stdout"].splitlines():
            parts = line.split()
            if len(parts) >= 2:
                parts[1] = _redact_remote(parts[1])
            remotes.append("\t".join(parts))
        manifests = []
        top_level = []
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if child.name == ".git" or child.is_symlink():
                continue
            top_level.append(child.name + ("/" if child.is_dir() else ""))
            if child.is_file() and child.name in {
                "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
                "pom.xml", "build.gradle", "Dockerfile", "docker-compose.yml",
                "docker-compose.yaml", "compose.yml", "compose.yaml", "README.md", "AGENTS.md",
            }:
                manifests.append(child.name)
        return _ok(
            tool,
            args,
            root=str(root),
            branch=branch["stdout"].strip() or None,
            head=head["stdout"].strip() if head["exit_code"] == 0 else None,
            status=status["stdout"].splitlines(),
            clean=(status["exit_code"] == 0 and len(status["stdout"].splitlines()) <= 1),
            remotes=remotes,
            manifests=manifests,
            top_level=top_level[:300],
        )
    except Exception as exc:
        return _fail(tool, args, exc)


def _blocked_filename(path: Path, policy: dict[str, Any]) -> bool:
    name = path.name
    return any(fnmatch(name, pattern) for pattern in _denied_globs(policy))


def _redact_line(line: str) -> str:
    assignment = re.compile(
        r"(?i)^(\s*[^#\n]*(?:password|passwd|token|secret|api[_-]?key|authorization|bearer)[^:=\n]*[:=]\s*)(.+)$"
    )
    match = assignment.match(line)
    if match:
        return match.group(1) + "[REDACTED]"
    if "BEGIN " in line and "PRIVATE KEY" in line:
        return "[REDACTED PRIVATE KEY MATERIAL]"
    return line


def host_file_read(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "host_file_read"
    try:
        path, policy = _check_allowed(args.get("path"), file=True)
        if _blocked_filename(path, policy):
            raise PermissionError(f"Sensitive filename is blocked: {path.name}")
        limit = min(int(policy.get("read", {}).get("max_bytes", 524288)), 2 * 1024 * 1024)
        size = path.stat().st_size
        if size > limit:
            raise ValueError(f"File is too large: {size} bytes; limit is {limit}")
        raw = path.read_bytes()
        if b"\x00" in raw:
            raise ValueError("Binary files cannot be read")
        text = raw.decode("utf-8", errors="replace")
        lines = text.splitlines()
        start_line = max(1, int(args.get("start_line", 1)))
        configured_lines = int(policy.get("read", {}).get("max_lines", 400))
        max_lines = min(max(1, int(args.get("max_lines", 200))), configured_lines, 400)
        selected = lines[start_line - 1:start_line - 1 + max_lines]
        content = "\n".join(
            f"L{number}: {_redact_line(line)}"
            for number, line in enumerate(selected, start=start_line)
        )
        return _ok(
            tool,
            args,
            path=str(path),
            start_line=start_line,
            returned_lines=len(selected),
            total_lines=len(lines),
            truncated=(start_line - 1 + len(selected) < len(lines)),
            content=content,
        )
    except Exception as exc:
        return _fail(tool, args, exc)


def project_register_readonly(args: dict[str, Any], **kwargs: Any) -> str:
    del kwargs
    tool = "project_register_readonly"
    try:
        name = args.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,63}", name):
            raise ValueError("Invalid registry name")
        path, _ = _check_allowed(args.get("path"), directory=True)
        top = _run(["git", "-C", str(path), "rev-parse", "--show-toplevel"])
        if top["exit_code"] != 0:
            raise ValueError("Only Git repository roots can be registered")
        root = Path(top["stdout"].strip()).resolve(strict=True)
        if root != path:
            raise ValueError(f"Path must be the Git repository root: {root}")
        description = args.get("description", "")
        if not isinstance(description, str):
            raise ValueError("description must be a string")
        registry_path = _registry_path()
        with registry_path.open("r", encoding="utf-8") as stream:
            registry = yaml.safe_load(stream) or {}
        projects = registry.setdefault("projects", {})
        if not isinstance(projects, dict):
            raise ValueError("projects.yaml projects must be a mapping")
        existing = projects.get(name)
        if isinstance(existing, dict):
            existing_root = Path(os.path.expanduser(str(existing.get("root", "")))).resolve(strict=False)
            if existing_root != root:
                raise FileExistsError(f"Registry name already points elsewhere: {name}")
            return _ok(tool, args, name=name, root=str(root), already_registered=True)
        projects[name] = {
            "description": description.strip() or f"Read-only project registered by Lucy: {name}",
            "root": str(root),
            "enabled": True,
            "architect_read": True,
            "max_read_bytes": 524288,
            "excluded_dirs": [
                ".git", "node_modules", "venv", ".venv", "dist", "build",
                "coverage", "__pycache__", ".next", ".cache",
            ],
            "registration": {
                "mode": "lucy-readonly",
                "registered_at": datetime.now(timezone.utc).isoformat(),
            },
        }
        temporary = registry_path.with_suffix(".yaml.tmp")
        with temporary.open("w", encoding="utf-8") as stream:
            yaml.safe_dump(registry, stream, sort_keys=False, allow_unicode=True)
        os.chmod(temporary, 0o600)
        temporary.replace(registry_path)
        return _ok(tool, args, name=name, root=str(root), already_registered=False)
    except Exception as exc:
        return _fail(tool, args, exc)
PY

echo
echo "=== 6. Patch plugin registration ==="

"$HERMES_PY" - "$PLUGIN_HOME/__init__.py" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

if "from . import host_schemas" not in text:
    anchor = "from . import gate_schemas\n"
    if anchor not in text:
        raise SystemExit("FAIL: import anchor missing in plugin __init__.py")
    text = text.replace(anchor, anchor + "from . import host_schemas\nfrom . import host_tools\n", 1)

marker = "# LUCY_CONTROLLED_HOST_TOOLS_V1"
if marker not in text:
    block = r'''

    # LUCY_CONTROLLED_HOST_TOOLS_V1
    host_tools_registered = [
        (
            "host_overview",
            host_schemas.HOST_OVERVIEW,
            host_tools.host_overview,
            "Read-only host overview without secrets.",
            "lucy-host-read",
        ),
        (
            "service_overview",
            host_schemas.SERVICE_OVERVIEW,
            host_tools.service_overview,
            "Read-only Docker and systemd inventory.",
            "lucy-host-read",
        ),
        (
            "repository_discover",
            host_schemas.REPOSITORY_DISCOVER,
            host_tools.repository_discover,
            "Discover repositories beneath controlled roots.",
            "lucy-host-read",
        ),
        (
            "repository_inspect",
            host_schemas.REPOSITORY_INSPECT,
            host_tools.repository_inspect,
            "Inspect a discovered repository with fixed Git commands.",
            "lucy-host-read",
        ),
        (
            "host_file_read",
            host_schemas.HOST_FILE_READ,
            host_tools.host_file_read,
            "Read bounded non-secret host text files.",
            "lucy-host-read",
        ),
        (
            "project_register_readonly",
            host_schemas.PROJECT_REGISTER_READONLY,
            host_tools.project_register_readonly,
            "Register a discovered Git repository for Lucy read-only analysis.",
            "lucy-project-registry",
        ),
    ]

    for name, schema, handler, description, toolset in host_tools_registered:
        ctx.register_tool(
            name=name,
            toolset=toolset,
            schema=schema,
            handler=handler,
            description=description,
            emoji="🔎",
        )
'''
    text = text.rstrip() + block + "\n"

path.write_text(text, encoding="utf-8")
PY

echo
echo "=== 7. Update plugin manifest and Lucy toolsets ==="

"$HERMES_PY" - "$PLUGIN_HOME/plugin.yaml" "$CONFIG_FILE" <<'PY'
from pathlib import Path
import sys
import yaml

manifest_path = Path(sys.argv[1])
config_path = Path(sys.argv[2])

with manifest_path.open("r", encoding="utf-8") as stream:
    manifest = yaml.safe_load(stream) or {}
manifest["version"] = "1.3.0"
provided = manifest.get("provides_tools")
if not isinstance(provided, list):
    provided = []
for name in [
    "host_overview", "service_overview", "repository_discover",
    "repository_inspect", "host_file_read", "project_register_readonly",
]:
    if name not in provided:
        provided.append(name)
manifest["provides_tools"] = provided
with manifest_path.open("w", encoding="utf-8") as stream:
    yaml.safe_dump(manifest, stream, sort_keys=False, allow_unicode=True)

with config_path.open("r", encoding="utf-8") as stream:
    config = yaml.safe_load(stream) or {}
toolsets = config.setdefault("platform_toolsets", {}).setdefault("cli", [])
for name in ["lucy-host-read", "lucy-project-registry"]:
    if name not in toolsets:
        toolsets.append(name)
with config_path.open("w", encoding="utf-8") as stream:
    yaml.safe_dump(config, stream, sort_keys=False, allow_unicode=True)

print("Lucy CLI toolsets:", toolsets)
PY

chmod 600 \
  "$PLUGIN_HOME/host_schemas.py" \
  "$PLUGIN_HOME/host_tools.py" \
  "$PLUGIN_HOME/__init__.py" \
  "$PLUGIN_HOME/plugin.yaml" \
  "$CONFIG_FILE"

echo
echo "=== 8. Clarify Lucy architect role ==="

if [[ -f "$SOUL_FILE" ]] && ! grep -q 'Controlled Host Discovery' "$SOUL_FILE"; then
cat >> "$SOUL_FILE" <<'EOF'

## Controlled Host Discovery

You are not limited to projects already registered in the project registry.
When the user refers to an unknown local service or repository, use the controlled
host tools to discover and inspect it. You may register a discovered Git repository
for read-only Architect analysis. Do not claim that you need a different profile or
runtime until you have actually used host_overview, repository_discover, and
service_overview and reported their concrete results.

These capabilities do not grant arbitrary shell execution or source modification.
Implementation remains delegated through Task Contracts to Xixi.
EOF
fi

if [[ -f "$SKILL_FILE" ]] && ! grep -q 'Unknown Project Discovery' "$SKILL_FILE"; then
cat >> "$SKILL_FILE" <<'EOF'

## Unknown Project Discovery

For a project that is not registered:

1. Call `repository_discover` using the service or repository name.
2. Use `service_overview` when a running container or service may reveal its identity.
3. Call `repository_inspect` on plausible Git roots.
4. Read only necessary non-secret manifests with `host_file_read`.
5. Register the confirmed Git root with `project_register_readonly`.
6. Continue with `project_snapshot`, `project_tree`, `project_read`, and Architecture Packet creation.

Do not ask Tei to locate a project before exhausting these controlled discovery tools.
Do not request generic terminal access merely because a project is not registered.
EOF
fi

chmod 600 "$SOUL_FILE" "$SKILL_FILE" 2>/dev/null || true

echo
echo "=== 9. Compile plugin ==="

"$HERMES_PY" -m py_compile \
  "$PLUGIN_HOME/__init__.py" \
  "$PLUGIN_HOME/host_schemas.py" \
  "$PLUGIN_HOME/host_tools.py"

echo
echo "=== 10. Deterministic handler smoke tests ==="

"$HERMES_PY" - "$PLUGIN_HOME/host_tools.py" <<'PY'
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
spec = spec_from_file_location("lucy_host_tools_test", path)
if spec is None or spec.loader is None:
    raise SystemExit("FAIL: cannot load host_tools.py")
module = module_from_spec(spec)
spec.loader.exec_module(module)

def call(handler, args):
    result = json.loads(handler(args))
    print(handler.__name__, "success=", result.get("success"))
    if result.get("success") is not True:
        raise SystemExit(f"FAIL: {handler.__name__}: {result}")
    return result

call(module.host_overview, {})
call(module.service_overview, {"include_docker": True, "include_systemd": False})
discovered = call(module.repository_discover, {
    "query": "chat.ailucy.online",
    "max_depth": 6,
    "max_results": 50,
})
print("chat.ailucy.online candidates:")
for item in discovered.get("repositories", []):
    print(" -", item.get("path"))

blocked = json.loads(module.host_file_read({"path": str(Path.home() / ".ssh" / "id_rsa")}))
if blocked.get("success") is not False:
    raise SystemExit("FAIL: sensitive path was not blocked")
print("Sensitive-path block: PASS")
PY

echo
echo "=== 11. Hermes visibility ==="

lucy plugins list || true
lucy tools --summary || true

echo
echo "PASS: Lucy controlled Architect discovery capabilities restored."
