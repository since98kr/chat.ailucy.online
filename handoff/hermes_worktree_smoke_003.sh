#!/usr/bin/env bash
set -euo pipefail

HERMES=/home/since98kr/.hermes/hermes-agent/venv/bin/hermes
SMOKE_REPO=/home/since98kr/.hermes/smoke-repos/hermes-worktree-smoke
TASK_BODY=/tmp/TASK-HERMES-WORKTREE-SMOKE-003.md
CREATE_JSON=/tmp/hermes-worktree-smoke-003-create.json
IDEMPOTENCY_KEY=hermes-worktree-smoke-003
BRANCH=smoke/hermes-worktree-003

echo '=== Preflight ==='
test -x "$HERMES"
test -d "$SMOKE_REPO/.git"
git -C "$SMOKE_REPO" diff --quiet
git -C "$SMOKE_REPO" diff --cached --quiet
bash -n "$SMOKE_REPO/test_smoke.sh"

cat > "$TASK_BODY" <<'EOF'
## 목적

Dispatcher가 생성한 영구 Git worktree에서 Xixi가 targeted patch를 실제 수행하고,
작업 완료 후에도 변경 결과가 호스트에 보존되는지 검증한다.

## 실행환경 계약

- Dispatcher가 배정하고 컨테이너에 마운트한 workspace에서만 작업한다.
- 컨테이너 내부 작업 경로는 `/workspace`다.
- 호스트의 `/home/since98kr/.hermes/...` 경로를 컨테이너 안에서 직접 접근하거나 생성하지 않는다.
- `/tmp`, 홈 디렉터리, 별도 workspace로 우회하지 않는다.
- `/workspace`가 Git worktree가 아니면 즉시 kanban_block을 호출한다.
- `/workspace/smoke_target.txt`와 `/workspace/test_smoke.sh`가 없으면 수정하지 말고 kanban_block을 호출한다.

## 수정 허용 범위

수정 가능한 파일은 다음 하나뿐이다.

`smoke_target.txt`

다음 anchor를 정확히 한 번만 교체한다.

기존:

`WORKTREE_SMOKE_STATUS=PENDING`

변경:

`WORKTREE_SMOKE_STATUS=PATCHED`

다음 행은 절대 변경하지 않는다.

`UNCHANGED_SENTINEL=KEEP`

## 금지사항

- whole-file overwrite 금지
- 다른 파일 수정·생성·삭제 금지
- test_smoke.sh 수정 금지
- commit 생성 금지
- Hermes 코어, profile, Harness, systemd, canonical repository 수정 금지
- 자연어만으로 완료 주장 금지

## 작업 전 검증

다음을 실제 실행한다.

```bash
pwd
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git branch --show-current
git status --short
cat smoke_target.txt
grep -Fxc 'WORKTREE_SMOKE_STATUS=PENDING' smoke_target.txt
grep -Fxc 'UNCHANGED_SENTINEL=KEEP' smoke_target.txt
```

다음 조건을 모두 만족해야 수정한다.

- `pwd`가 `/workspace`
- Git worktree 판정이 `true`
- 작업 시작 시 working tree가 clean
- PENDING anchor가 정확히 1개
- sentinel이 정확히 1개

## Patch 방법

Python 또는 Perl을 사용해 exact anchor replacement를 수행한다.
교체 횟수가 정확히 1회가 아니면 파일을 쓰지 말고 실패 처리한다.

## 작업 후 검증

다음을 실제 실행한다.

```bash
grep -Fxq 'WORKTREE_SMOKE_STATUS=PATCHED' smoke_target.txt
grep -Fxq 'UNCHANGED_SENTINEL=KEEP' smoke_target.txt
./test_smoke.sh
git diff --check
git diff --name-only
git status --short
git diff -- smoke_target.txt
git log -1 --oneline
```

## 성공 조건

- `./test_smoke.sh` exit code 0
- 출력에 `WORKTREE_SMOKE_TEST_PASS`
- `git diff --check` exit code 0
- `git diff --name-only` 결과가 정확히 `smoke_target.txt`
- `git status --short`에 smoke_target.txt 수정만 존재
- sentinel 유지
- commit 미생성

## Kanban 처리

성공 시 실제 결과를 Kanban comment에 기록한다.

- pwd
- Git top-level
- branch
- 변경 파일
- 테스트 출력
- 명령별 exit code
- git status
- 전체 git diff
- commit을 만들지 않았다는 확인
- 우회 경로를 사용하지 않았다는 확인

모든 조건이 성공하면 `kanban_complete`를 실제 호출한다.

하나라도 실패하면 추가 우회나 범위 확대를 하지 말고,
원인을 기록한 후 `kanban_block`을 실제 호출한다.
EOF

echo '=== Create task ==='
TASK_JSON="$(
  "$HERMES" kanban create \
    "TASK-HERMES-WORKTREE-SMOKE-003" \
    --body "$(cat "$TASK_BODY")" \
    --assignee xixi \
    --workspace "worktree:$SMOKE_REPO" \
    --branch "$BRANCH" \
    --max-retries 1 \
    --max-runtime 10m \
    --created-by tei \
    --idempotency-key "$IDEMPOTENCY_KEY" \
    --json
)"

printf '%s\n' "$TASK_JSON" | tee "$CREATE_JSON"

TASK_ID="$(
  python3 - "$CREATE_JSON" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())

candidates = []
if isinstance(data, dict):
    candidates.extend([data.get("id"), data.get("task_id")])
    task = data.get("task")
    if isinstance(task, dict):
        candidates.extend([task.get("id"), task.get("task_id")])

task_id = next((str(v) for v in candidates if v), None)
if not task_id:
    raise SystemExit(f"Task ID not found in response: {data!r}")

print(task_id)
PY
)"

echo "TASK_ID=$TASK_ID"

echo '=== Created task ==='
"$HERMES" kanban show "$TASK_ID"

echo '=== Dispatch once ==='
"$HERMES" kanban dispatch || true
sleep 2

echo '=== Current state ==='
"$HERMES" kanban show "$TASK_ID"
"$HERMES" kanban runs "$TASK_ID" || true

echo
echo 'Task has been created and dispatched.'
echo "To follow live events:"
echo "  $HERMES kanban tail $TASK_ID"
echo
echo "After completion, run this same script with:"
echo "  $0 --verify $TASK_ID"

if [[ "${1:-}" == "--verify" ]]; then
  TASK_ID="${2:-$TASK_ID}"
fi

if [[ "${1:-}" == "--verify" ]]; then
  echo '=== Final task evidence ==='
  SHOW_FILE="/tmp/${TASK_ID}-show.txt"

  "$HERMES" kanban show "$TASK_ID" | tee "$SHOW_FILE"
  "$HERMES" kanban runs "$TASK_ID" || true
  "$HERMES" kanban log "$TASK_ID" || true

  WORKTREE_PATH="$(
    sed -n 's/^[[:space:]]*workspace:.* @ //p' "$SHOW_FILE" |
    head -1
  )"

  echo "WORKTREE_PATH=$WORKTREE_PATH"
  test -n "$WORKTREE_PATH"
  test -d "$WORKTREE_PATH"

  echo '=== Worktree identity ==='
  git -C "$WORKTREE_PATH" rev-parse --is-inside-work-tree
  git -C "$WORKTREE_PATH" rev-parse --show-toplevel
  git -C "$WORKTREE_PATH" branch --show-current

  echo '=== Preserved result ==='
  cat "$WORKTREE_PATH/smoke_target.txt"

  echo '=== Host-side test ==='
  (
    cd "$WORKTREE_PATH"
    ./test_smoke.sh
  )

  echo '=== Changed files ==='
  git -C "$WORKTREE_PATH" status --short
  git -C "$WORKTREE_PATH" diff --name-only
  git -C "$WORKTREE_PATH" diff --check
  git -C "$WORKTREE_PATH" diff -- smoke_target.txt

  echo '=== Registered worktrees ==='
  git -C "$SMOKE_REPO" worktree list --porcelain

  echo '=== Original main repository ==='
  git -C "$SMOKE_REPO" branch --show-current
  git -C "$SMOKE_REPO" status --short
  cat "$SMOKE_REPO/smoke_target.txt"
fi
