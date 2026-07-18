#!/usr/bin/env bash
set -euo pipefail

TASK_ID=t_3444f024
HERMES_HOME=/home/since98kr/.hermes
HERMES_AGENT="$HERMES_HOME/hermes-agent"
SMOKE_REPO="$HERMES_HOME/smoke-repos/hermes-worktree-smoke"
WORKTREE="$SMOKE_REPO/.worktrees/$TASK_ID"
STAMP="$(date +%Y%m%d_%H%M%S)"
LOG="/tmp/hermes_xixi_workspace_diagnose_005_${STAMP}.log"
REMOTE_PATH="handoff/hermes_xixi_workspace_diagnose_005_${STAMP}.log"
PAYLOAD="/tmp/hermes_xixi_workspace_diagnose_005_payload_${STAMP}.json"
IMAGE="nikolaik/python-nodejs:python3.11-nodejs20"

exec > >(tee "$LOG") 2>&1

run() {
  echo
  printf '###'
  printf ' %q' "$@"
  echo
  set +e
  "$@"
  rc=$?
  set -e
  echo "[exit=$rc]"
  return 0
}

echo "HERMES XIXI WORKSPACE DIAGNOSTIC 005"
echo "timestamp=$(date --iso-8601=seconds)"
echo "host=$(hostname)"
echo "user=$(id -un)"
echo "task_id=$TASK_ID"
echo "smoke_repo=$SMOKE_REPO"
echo "worktree=$WORKTREE"

echo
echo '=== WORKTREE STATE ==='
run test -d "$WORKTREE"
run ls -la "$WORKTREE"
run cat "$WORKTREE/.git"
run git -C "$WORKTREE" rev-parse --is-inside-work-tree
run git -C "$WORKTREE" rev-parse --show-toplevel
run git -C "$WORKTREE" rev-parse --git-dir
run git -C "$WORKTREE" rev-parse --git-common-dir
run git -C "$WORKTREE" status --short --branch
run cat "$WORKTREE/smoke_target.txt"

echo
echo '=== SAFE TERMINAL CONFIG SUMMARY ==='
"$HERMES_AGENT/venv/bin/python3" - "$HERMES_HOME" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
paths = [
    root / "config.yaml",
    root / "profiles" / "xixi" / "config.yaml",
    root / "profiles" / "xixi" / "config.yml",
]

safe_keys = {
    "backend",
    "cwd",
    "home_mode",
    "timeout",
    "docker_image",
    "docker_volumes",
    "docker_extra_args",
    "docker_network",
    "docker_mount_cwd_to_workspace",
    "docker_persist_across_processes",
    "docker_orphan_reaper",
    "docker_run_as_host_user",
    "container_cpu",
    "container_memory",
    "container_disk",
    "container_persistent",
    "persistent_shell",
    "lifetime_seconds",
}

try:
    import yaml
except Exception as exc:
    yaml = None
    print(f"yaml_import_error={exc!r}")

for path in paths:
    print(f"\n--- {path} ---")
    if not path.is_file():
        print("missing")
        continue
    if yaml is None:
        print("present; YAML parser unavailable")
        continue
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        print(f"parse_error={exc!r}")
        continue
    terminal = data.get("terminal") if isinstance(data, dict) else None
    if not isinstance(terminal, dict):
        print("terminal: <missing>")
        continue
    for key in sorted(safe_keys):
        if key in terminal:
            print(f"terminal.{key}={terminal[key]!r}")

print("\n--- safe environment overrides ---")
safe_env = [
    "TERMINAL_ENV",
    "TERMINAL_CWD",
    "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE",
    "TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES",
    "TERMINAL_DOCKER_RUN_AS_HOST_USER",
    "TERMINAL_CONTAINER_PERSISTENT",
    "HERMES_KANBAN_TASK",
    "HERMES_KANBAN_WORKSPACE",
    "HERMES_KANBAN_BRANCH",
    "HERMES_KANBAN_BOARD",
    "HERMES_KANBAN_WORKSPACES_ROOT",
]
for name in safe_env:
    if name in os.environ:
        print(f"{name}={os.environ[name]!r}")
    else:
        print(f"{name}=<unset>")

for name in ["TERMINAL_DOCKER_VOLUMES", "TERMINAL_DOCKER_EXTRA_ARGS"]:
    print(f"{name}_is_set={name in os.environ}")
PY

echo
echo '=== CONFIG FILE LOCATIONS ==='
run bash -lc "find '$HERMES_HOME' -maxdepth 4 -type f \( -name 'config.yaml' -o -name 'config.yml' \) -print"

echo
echo '=== HERMES-MANAGED CONTAINERS ==='
run docker ps -a --filter label=hermes-agent=1 --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Labels}}'
for c in $(docker ps -aq --filter label=hermes-agent=1); do
  echo
  echo "--- container=$c ---"
  run docker inspect --format 'Name={{.Name}} Image={{.Config.Image}} WorkingDir={{.Config.WorkingDir}} Labels={{json .Config.Labels}}' "$c"
  run docker inspect --format '{{json .Mounts}}' "$c"
done

echo
echo '=== READ-ONLY DOCKER MOUNT PROBE A: WORKTREE ONLY ==='
set +e
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=64m \
  -v "$WORKTREE:/workspace:ro" \
  -w /workspace \
  "$IMAGE" \
  bash -lc 'pwd; cat .git; git rev-parse --is-inside-work-tree; git status --short --branch' \
  2>&1
rc=$?
set -e
echo "[probe_a_exit=$rc]"

echo
echo '=== READ-ONLY DOCKER MOUNT PROBE B: WORKTREE + COMMON REPO SAME HOST PATH ==='
set +e
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,size=64m \
  -v "$SMOKE_REPO:$SMOKE_REPO:ro" \
  -v "$WORKTREE:/workspace:ro" \
  -w /workspace \
  "$IMAGE" \
  bash -lc 'pwd; cat .git; git rev-parse --is-inside-work-tree; git rev-parse --show-toplevel; git rev-parse --git-common-dir; git status --short --branch' \
  2>&1
rc=$?
set -e
echo "[probe_b_exit=$rc]"

echo
echo '=== RELEVANT LOCAL SOURCE REFERENCES ==='
run bash -lc "grep -R -n --exclude-dir=.git --exclude='*.pyc' 'docker_mount_cwd_to_workspace' '$HERMES_AGENT' | head -80"
run bash -lc "grep -R -n --exclude-dir=.git --exclude='*.pyc' 'HERMES_KANBAN_WORKSPACE' '$HERMES_AGENT' | head -120"
run bash -lc "grep -R -n --exclude-dir=.git --exclude='*.pyc' 'hermes-task-id' '$HERMES_AGENT' | head -80"
run bash -lc "grep -R -n --exclude-dir=.git --exclude='*.pyc' 'HERMES_KANBAN_TASK' '$HERMES_AGENT/tools' '$HERMES_AGENT/hermes_cli' 2>/dev/null | head -120"

echo
echo '=== UPDATE NOTICE VALIDITY ==='
run git -C "$HERMES_AGENT" status --short --branch
run git -C "$HERMES_AGENT" rev-parse HEAD
run git -C "$HERMES_AGENT" rev-parse '@{upstream}'
run git -C "$HERMES_AGENT" log --oneline HEAD..@{upstream}
run git -C "$HERMES_AGENT" diff --name-status HEAD..@{upstream}

echo
echo '=== SAFETY: ORIGINAL AND TASK WORKTREE REMAIN UNCHANGED ==='
run git -C "$SMOKE_REPO" status --short --branch
run cat "$SMOKE_REPO/smoke_target.txt"
run git -C "$WORKTREE" status --short --branch
run cat "$WORKTREE/smoke_target.txt"

echo
echo '=== UPLOAD LOG ==='
python3 - "$LOG" "$PAYLOAD" <<'PY'
import base64
import json
import sys
from pathlib import Path

log_path = Path(sys.argv[1])
payload_path = Path(sys.argv[2])
payload = {
    "message": f"Upload Hermes Xixi workspace diagnostic: {log_path.name}",
    "content": base64.b64encode(log_path.read_bytes()).decode("ascii"),
    "branch": "main",
}
payload_path.write_text(json.dumps(payload), encoding="utf-8")
PY

gh api \
  --method PUT \
  "repos/since98kr/chat.ailucy.online/contents/$REMOTE_PATH" \
  --input "$PAYLOAD" \
  --jq '.content.html_url'

rm -f "$PAYLOAD"
echo "UPLOADED_PATH=$REMOTE_PATH"
