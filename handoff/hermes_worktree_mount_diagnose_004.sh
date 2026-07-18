#!/usr/bin/env bash
set -uo pipefail

HERMES=/home/since98kr/.hermes/hermes-agent/venv/bin/hermes
HERMES_REPO=/home/since98kr/.hermes/hermes-agent
SMOKE_REPO=/home/since98kr/.hermes/smoke-repos/hermes-worktree-smoke
TASK_ID=t_3444f024
EXPECTED_WORKTREE="$SMOKE_REPO/.worktrees/$TASK_ID"
LOG="/tmp/hermes_worktree_mount_diagnose_004_$(date +%Y%m%d_%H%M%S).log"
REMOTE_PATH="handoff/$(basename "$LOG")"
PAYLOAD=/tmp/hermes_worktree_mount_diagnose_upload.json

run() {
  echo
  echo "### $*"
  "$@" 2>&1
  local rc=$?
  echo "[exit=$rc]"
  return 0
}

{
  echo 'HERMES WORKTREE/MOUNT DIAGNOSTIC 004'
  echo "timestamp=$(date --iso-8601=seconds)"
  echo "host=$(hostname)"
  echo "user=$(id -un)"
  echo "task_id=$TASK_ID"
  echo "smoke_repo=$SMOKE_REPO"
  echo "expected_worktree=$EXPECTED_WORKTREE"

  run "$HERMES" --version
  run "$HERMES" kanban show "$TASK_ID"
  run "$HERMES" kanban runs "$TASK_ID"
  run "$HERMES" kanban log "$TASK_ID"
  run "$HERMES" kanban diagnostics

  echo
  echo '=== SOURCE REPOSITORY ==='
  run test -d "$SMOKE_REPO/.git"
  run git -C "$SMOKE_REPO" status --short --branch
  run git -C "$SMOKE_REPO" log --oneline --decorate -5
  run git -C "$SMOKE_REPO" worktree list --porcelain
  run git -C "$SMOKE_REPO" branch --all --verbose --no-abbrev
  run git -C "$SMOKE_REPO" show-ref --heads

  echo
  echo '=== EXPECTED WORKTREE PATH ==='
  run ls -ld "$SMOKE_REPO" "$SMOKE_REPO/.worktrees" "$EXPECTED_WORKTREE"
  run find "$SMOKE_REPO" -maxdepth 3 -mindepth 1 -printf '%M %u:%g %p\n'
  run find "$SMOKE_REPO/.git/worktrees" -maxdepth 3 -printf '%M %u:%g %p\n'

  echo
  echo '=== HERMES INSTALLATION STATE ==='
  run git -C "$HERMES_REPO" status --short --branch
  run git -C "$HERMES_REPO" log --oneline --decorate -5
  run git -C "$HERMES_REPO" log --oneline HEAD..@{upstream}
  run git -C "$HERMES_REPO" diff --stat HEAD..@{upstream}
  run git -C "$HERMES_REPO" diff --name-status HEAD..@{upstream}

  echo
  echo '=== HERMES/GATEWAY PROCESSES ==='
  run bash -lc "ps -ef | grep -E '[h]ermes|[x]ixi'"
  run bash -lc "systemctl --user list-units --type=service --all | grep -Ei 'hermes|gateway' || true"

  echo
  echo '=== USER SERVICE STATUS ==='
  while IFS= read -r unit; do
    [ -n "$unit" ] || continue
    run systemctl --user status "$unit" --no-pager -l
    run journalctl --user-unit "$unit" --since '2026-07-18 11:20:00' --until '2026-07-18 11:27:00' --no-pager -o short-iso
  done < <(systemctl --user list-units --type=service --all --no-legend 2>/dev/null | awk 'tolower($1) ~ /hermes|gateway/ {print $1}')

  echo
  echo '=== DOCKER CONTAINERS AND MOUNTS ==='
  run docker ps -a --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    echo
    echo "--- container=$container ---"
    run docker inspect --format 'Name={{.Name}} Image={{.Config.Image}} WorkingDir={{.Config.WorkingDir}}' "$container"
    run docker inspect --format '{{json .Mounts}}' "$container"
    run docker inspect --format '{{json .Config.Labels}}' "$container"
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Ei 'hermes|xixi|agent' || true)

  echo
  echo '=== TASK-RELATED FILES ==='
  run bash -lc "find /home/since98kr/.hermes -maxdepth 8 -type f -name '*${TASK_ID}*' -print"
  run bash -lc "find /home/since98kr/.hermes -maxdepth 8 -type d -name '*${TASK_ID}*' -print"

  echo
  echo '=== SAFETY CHECK: ORIGINAL FIXTURE ==='
  run cat "$SMOKE_REPO/smoke_target.txt"
  run bash -n "$SMOKE_REPO/test_smoke.sh"
  run git -C "$SMOKE_REPO" status --short
} | tee "$LOG"

python3 - "$LOG" "$PAYLOAD" <<'PY'
import base64
import json
import sys
from pathlib import Path

log_path = Path(sys.argv[1])
payload_path = Path(sys.argv[2])

payload = {
    "message": f"Upload Hermes worktree mount diagnostic: {log_path.name}",
    "content": base64.b64encode(log_path.read_bytes()).decode("ascii"),
    "branch": "main",
}
payload_path.write_text(json.dumps(payload), encoding="utf-8")
PY

if command -v gh >/dev/null 2>&1; then
  gh api \
    --method PUT \
    "repos/since98kr/chat.ailucy.online/contents/$REMOTE_PATH" \
    --input "$PAYLOAD" \
    --jq '.content.html_url'
  echo "UPLOADED_PATH=$REMOTE_PATH"
else
  echo 'ERROR: gh CLI not found; diagnostic log remains local.'
  echo "LOCAL_LOG=$LOG"
fi

rm -f "$PAYLOAD"
