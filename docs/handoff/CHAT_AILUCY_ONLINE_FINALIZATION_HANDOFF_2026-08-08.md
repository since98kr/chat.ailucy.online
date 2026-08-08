# chat.ailucy.online 최종 마무리 개발 인수인계

- 문서 유형: 외부/별도 개발 조력자용 실행 인수인계
- 작성 기준: 2026-08-08 15:47 Asia/Seoul
- Repository: `since98kr/chat.ailucy.online`
- Handoff branch: `handoff/chat-finalization-2026-08-08`
- 제품 코드 Reality 기준 SHA: `5c15b923668b8a1116eb82444814b047e4d4588c`
- 제품 상태: **SOURCE MOSTLY IMPLEMENTED / STAGING & RUNTIME ACCEPTANCE INCOMPLETE / PRODUCTION NOT AUTHORIZED**
- 최상위 완료 계약: Issue `#76` — `[P0] Complete Chat with both Letta CLI parity and Hermes CLI parity`

> 중요: 이 문서는 제품 `main`을 변경하지 않기 위해 별도 handoff branch에만 존재한다. 실제 개발을 시작할 때는 이 문서에 적힌 SHA를 고정된 최신값으로 믿지 말고 반드시 GitHub Reality Read를 먼저 수행한다. 단, 아래의 설계 결정·안전 경계·과거 증거는 새 Reality와 충돌하지 않는 한 인수인계 기준으로 사용한다.

---

## 0. 가장 먼저 읽을 요약

`chat.ailucy.online`은 단순 채팅 UI를 만드는 단계가 아니다. UI/기본 제품 구조/대부분의 adapter 및 security/recovery 기반은 이미 상당히 구현되어 있다. 남은 핵심은 **실제 agentlucy/staging 환경에서 Letta와 Hermes 양쪽을 진짜 runtime과 연결하고, 최종 사용자 관점의 exact-main E2E를 통과시키는 것**이다.

현재 가장 중요한 아키텍처 변경은 다음과 같다.

```text
기존 목표
Chat V2
  -> standalone Letta CLI bridge
  -> Letta가 직접 local tool 실행

현재 목표
Chat V2
  -> [Letta] Lucy라는 인지/정체성
  -> private authenticated OpenClaw Gateway
  -> Letta-backed Lucy cognition/session
  -> OpenClaw execution fabric
       workers / tools / tasks / scheduler / approvals / audit
```

즉 **Letta Lucy는 계속 cognitive identity이고, OpenClaw는 execution fabric**이다. OpenClaw가 Lucy persona나 장기 memory owner를 대체하는 구조가 아니다.

Hermes 쪽은 별도 runtime adapter를 유지한다. 최종 Chat 완료 기준은 다음 세 축 모두다.

1. Letta/OpenClaw path의 실제 parity + staging proof
2. Hermes CLI parity + 실제 runtime proof
3. Hermes approved subagent 선택/격리/실행 proof

그리고 두 backend 모두에 대해 attachment, generated artifact, retry/cancel/dedup, desktop/mobile, export 및 security/recovery 계약을 유지해야 한다.

---

# 1. GitHub Reality Snapshot

## 1.1 Current product main at handoff creation

Handoff 작성 직전 `main`의 exact SHA:

```text
5c15b923668b8a1116eb82444814b047e4d4588c
```

Commit:

```text
Add hosted OpenClaw staging configuration gate (#101)
```

바로 앞 핵심 main commits:

```text
5c15b923...  Add hosted OpenClaw staging configuration gate (#101)
b99e4a47...  Cut staging over to OpenClaw-backed Letta Lucy (#100)
08756f9b...  Add OpenClaw-backed transport for Letta Lucy (#99)
99763f4d...  Prove Letta local-tool execution with an environment-keyed HMAC (#97)
...
```

PR #99/#100/#101은 merge 완료다.

## 1.2 Current main status that matters

Current main commit status:

```text
context: chat-v2/openclaw-config
state: failure
run: 31228264406
```

이 실패는 **제품 코드가 빌드 실패했다는 뜻이 아니다.** Hosted workflow `.github/workflows/openclaw-staging-config-gate.yml`이 GitHub `staging` Environment의 OpenClaw 연결 계약을 검사하고 실패한 것이다.

이 gate가 검사하는 조건은 정확히 다음이다.

- `OPENCLAW_GATEWAY_BASE_URL` 존재
- `OPENCLAW_GATEWAY_TOKEN` secret 존재
- `LETTA_OPENCLAW_AGENT_TARGET`가 explicit OpenClaw target 형식
- `LETTA_OPENCLAW_SESSION_PREFIX` non-empty
- Gateway URL이 staging container에서 접근 불가능한 `localhost` / `127.0.0.1` loopback-only URL이 아님

**주의:** 현재 단순 commit status만으로는 위 항목 중 어느 것이 실패 원인인지 단정하지 말 것. Actions run `31228264406`의 exact step/log를 읽어서 원인을 분류한다. Secret 값은 절대 출력하지 않는다.

## 1.3 Current self-hosted runner evidence

Open diagnostic PR:

```text
PR #102
branch: ops/agentlucy-runner-service-diagnostic
HEAD: 4a5c226e51a39c79faef98d691fc3eb21f7e46b2
purpose: read-only runner service diagnostics only
merge: NOT REQUIRED
```

Exact PR #102 HEAD workflow reality:

```text
V2 CI run 31238397630: SUCCESS
Agentlucy Runner Service Diagnostic run 31238397651: QUEUED
```

Diagnostic workflow 자체의 hosted contract는 정상인데 self-hosted job이 실행되지 않고 queued 상태다. 이것은 **Chat source 코드 문제와 별개의 execution-plane 문제**로 다룬다.

역사적으로 알려진 Chat staging runner unit 이름:

```text
actions.runner.since98kr-chat.ailucy.online.agentlucy-chat-staging.service
```

이 이름을 현재 host의 진실로 무조건 가정하지 말고 `systemctl show` 등으로 존재/상태를 먼저 확인한다. 서비스 내용을 출력하거나 환경/credential을 덤프하지 않는다.

## 1.4 Important stale GitHub records

다음 기록들은 historical context로는 유용하지만 **현재 main보다 우선하지 않는다.**

### Issue #81
본문에는 historical branch/HEAD가 남아 있다.

```text
Implementation branch: xixi/hermes-cli-parity
Draft PR: #86
Current exact HEAD in issue body: 3c20b0...
```

그러나 PR #86은 이미 merge 완료되었고 최종 branch HEAD는 `49e36711569af84f3c0dfba375c7a784a634dbbb`였다. 따라서 Issue #81의 본문 SHA를 현재 implementation target으로 사용하지 말 것.

### Issue #93
standalone Letta CLI가 직접 local tool side effect를 증명하던 과거 completion lane이다. OpenClaw architecture로 전환된 뒤에는 이 direct Letta HMAC/filesystem proof가 새 path의 release criterion이 아니다.

Issue #93이 open 상태라고 해서 그 요구사항을 새 OpenClaw path에 그대로 구현하지 말 것. PR #98은 이미 "canonical Letta Lucy + OpenClaw architecture에 의해 superseded"라고 명시하며 closed/unmerged 처리됐다.

### Issues #78/#79
Xixi 기반 Hermes parity를 시도하던 historical planning issues다. 실제 worker accounting은 이후 Issue #81에서 정정되었다. branch 이름에 `xixi`가 있어도 Xixi runtime execution evidence로 간주하지 말 것.

---

# 2. 제품의 실제 목적과 최종 Definition of Done

Canonical umbrella는 Issue #76이다.

Chat이 완료되었다고 말하려면 **repository merge만으로는 부족하다.** 다음이 모두 충족되어야 한다.

## 2.1 Letta / OpenClaw path

사용자가 `[Letta] Lucy`와 대화할 때:

- Lucy cognitive identity가 유지된다.
- explicit OpenClaw Lucy agent target으로만 연결된다.
- 실제 private authenticated Gateway를 사용한다.
- 정확한 conversation별 session continuity가 있다.
- 한 user message가 duplicate inbound turn으로 재전송되지 않는다.
- interruption/retry/approval recovery가 prompt replay를 일으키지 않는다.
- harmless read-only tool/worker operation을 실제로 1회 이상 증명한다.
- raw tool args/results, credentials, private path, audit payload를 Chat browser에 노출하지 않는다.
- attachment가 실제 backend path를 통과한다.
- generated artifact가 Chat artifact contract로 돌아온다. 지원하지 않을 경우 명확하게 unsupported로 fail closed한다.
- Chat operation과 OpenClaw task/run/session/audit identity를 가능한 범위에서 연결하는 evidence가 남는다.

## 2.2 Hermes main agent parity

사용자가 `[Hermes] Lucy`와 대화할 때:

- reduced text-only adapter가 아니라 approved Hermes runtime identity를 사용한다.
- provider/model/runtime/selected-agent identity가 config guess가 아니라 bounded capability contract와 일치해야 한다.
- approved tools/skills/MCP가 기존 authorization boundary 안에서 제공된다.
- session continuity, cancellation, retry, idempotency/dedup가 동작한다.
- running/completed/failed lifecycle가 sanitized 형태로 보인다.
- generated artifacts가 기존 Chat artifact persistence/download contract를 사용한다.
- required capability가 없으면 fail closed한다.
- exact-main staging에서 harmless real execution이 실제로 증명되어야 한다.

## 2.3 Hermes approved subagent parity

Hermes main agent만 동작한다고 완료가 아니다.

- approved/visible subagent만 discover 가능
- explicit selection 필요
- selected agent identity를 turn마다 보존
- agent별 session/state 격리
- permissions/tools/skills/MCP boundary 보존
- artifacts/tool state/memory/session/retry state cross-agent leakage 금지
- agent switching으로 이전 agent context가 새 agent에 새지 않음을 증명
- staging에서 최소 1개의 approved subagent와 실제 bounded conversation proof

Historical supported/visible agents에는 Xixi, Lynn, Gemma 등이 있었다. 실제 current registry는 runtime에서 다시 조회한다.

## 2.4 Unified user-facing acceptance

양쪽 system 모두:

- attachment input
- generated artifact
- retry/regeneration
- stop/cancel semantics
- export
- desktop UX
- mobile UX
- authentication/session
- direct agent navigation
- team/federated flows that are still in scope

를 깨뜨리지 않아야 한다.

최종 완료 evidence는 다음을 하나의 exact candidate에 연결해야 한다.

```text
main SHA
+ CI
+ staging deployment run
+ runtime evidence
+ browser screenshots/results
+ adapter health/capability evidence
+ security/redaction evidence
+ zero unresolved P0/P1
```

Production deployment는 별도 승인 단계다.

---

# 3. 현재 아키텍처

## 3.1 Application stack

`package.json` 기준:

- Node.js 22 target
- TypeScript
- React + Vite frontend
- Fastify backend
- `better-sqlite3`
- Vitest
- Playwright
- `jose` auth/security support
- file/document extraction helpers (`mammoth`, `pdfjs-dist`)

Core scripts:

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run preflight
npm run preflight:strict
npm run test:e2e
npm run test:e2e:auth
npm run test:e2e:staging
npm run test:e2e:external
```

Bridge-specific tests:

```bash
npm run test:bridge
# node --test ops/letta-bridge/*.nodecheck.mjs
```

## 3.2 Domain model

```text
System
└── Conversation
    └── Participant / Agent
```

Major product concepts:

- Letta system
- Hermes system
- Conversations
- participants / lead / observer
- direct agent conversations
- explicit mentions
- federated conversations
- Memory Capsules
- workflow runs/steps/events
- attachments and generated artifacts
- archive/trash/search/branch/export

SQLite persistence uses WAL and foreign keys.

## 3.3 Letta/OpenClaw adapter

Current main contains:

```text
server/adapters/openclaw-letta.ts
server/adapters/openclaw-letta.test.ts
server/adapters/openclaw-letta.contract.md
```

Key behavior:

### Explicit runtime configuration

When `LETTA_PROTOCOL=openclaw`:

```text
LETTA_BASE_URL             -> private OpenClaw Gateway base URL
LETTA_CHAT_PATH            -> /v1/chat/completions
LETTA_HEALTH_PATH          -> /health
LETTA_API_KEY              -> server-side Gateway credential
LETTA_OPENCLAW_AGENT_TARGET
LETTA_OPENCLAW_SESSION_PREFIX
```

`LETTA_OPENCLAW_AGENT_TARGET` is mandatory and format-validated. Do not silently use a Gateway default agent.

### Session contract

The adapter maps a Chat Conversation to a stable OpenClaw session via:

```text
user = <session-prefix>:<conversation-id>
```

Default prefix is `chat-v2`.

### Prompt/context behavior

OpenClaw session is persistent. Therefore Chat does **not** replay the entire transcript every turn.

Current adapter sends:

- current user turn
- approved Memory Capsules
- current attachments

This is intentional. Full Chat transcript replay into a persistent OpenClaw session risks duplicate context / duplicate turn behavior.

### Attachments

- bounded per-file/aggregate sizes
- common images sent as data URLs
- supported non-image documents are extracted to text
- unsupported attachment types fail closed
- uploaded file is re-read and size consistency checked

### Generated artifacts

When `LETTA_ARTIFACT_TOOL_ENABLED=true`, OpenAI-compatible artifact tool support can receive generated artifact payloads through `RETURN_ARTIFACT_TOOL` / `OpenAiArtifactToolAccumulator` and pass them to Chat's artifact pipeline.

Do not bypass size/sanitization limits.

### Streaming

Supports OpenAI-compatible SSE/NDJSON-like streamed frames. Invalid JSON, backend error frame, non-2xx status or malformed trailing frame must fail rather than silently fabricate success.

## 3.4 OpenClaw role boundary

Canonical design decision:

```text
Letta Lucy:
- identity
- long-term memory
- cognition/judgment
- planning/orchestration intent

OpenClaw:
- workers
- tools
- tasks
- scheduler
- approvals
- audit
- execution/runtime concerns
```

Do not redesign Chat so OpenClaw becomes the user-visible Lucy persona.

## 3.5 Hermes adapter / parity status

PR #86 was merged and carried the major Hermes parity work.

Historically proven implementation included:

- selected-agent identity preservation
- explicit runtime/provider/model mapping
- fail-closed behavior when approved Hermes model mapping is absent
- capability handshake
- runtime-target authorization
- stable per-conversation/per-agent session identity
- scoped idempotency identity
- duplicate lifecycle suppression
- sanitized artifact/tool stream
- OpenAI-compatible `hermes_parity` extension
- selected-agent-only isolation metadata
- tests for team-agent identity isolation and stable retry identity

Final PR #86 evidence included:

```text
HEAD: 49e36711569af84f3c0dfba375c7a784a634dbbb
V2 CI run: 30386934999 SUCCESS
npm test: 74 Vitest + 17 bridge checks PASS
npm run typecheck PASS
npm run build PASS
```

하지만 이것은 source/CI proof다. 최종 Issue #76 계약은 **exact-main real staging tool/subagent proof**를 요구한다.

## 3.6 Authentication/security

Existing product security model includes:

- Cloudflare Access identity mode
- private token login -> HttpOnly/SameSite browser session exchange
- raw access token을 browser JS storage에 보존하지 않음
- bearer-token compatibility for controlled automation
- origin mutation protections
- route-class rate limits
- security headers
- no `/api` cache in PWA service worker

새 helper는 staging 문제를 고치겠다는 이유로 이 boundary를 우회하지 말 것.

## 3.7 Backup/recovery

Deployment contract already contains:

- online SQLite backup
- checksum manifest
- backup verification before replacement
- retained backups
- rollback on health/deployment failure

Staging deploy script는 strict preflight + backup + health + rollback을 사용한다. 새 helper는 ad-hoc `docker compose down`, DB copy, destructive reset로 staging을 살리지 말고 existing deployment/recovery scripts를 우선 사용한다.

---

# 4. OpenClaw migration의 현재 진실

## 4.1 PR #99 — transport support merged

Added:

```text
docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md
docs/OPENCLAW_LETTA_CHAT_MIGRATION.md
server/adapters/openclaw-letta.ts
server/adapters/openclaw-letta.test.ts
server/adapters/openclaw-letta.contract.md
server/adapters/index.ts
```

Important decision: native Letta fallback를 즉시 제거하지 않고 OpenClaw exact-main staging proof까지 보존했다.

## 4.2 PR #100 — staging cutover code merged

Changed:

```text
.github/workflows/deploy-staging.yml
.github/workflows/letta-full-runtime-ci.yml
.github/workflows/staging-preflight.yml
compose.staging.yml
scripts/ops/openclaw-letta-staging-smoke.sh
scripts/ops/staging-preflight.sh
```

Staging workflow now targets OpenClaw-backed Letta Lucy.

## 4.3 PR #101 — hosted config gate merged

Added:

```text
.github/workflows/openclaw-staging-config-gate.yml
```

Purpose: self-hosted runner가 죽어 있어도 OpenClaw staging Environment prerequisite가 빠져 있는지 GitHub-hosted runner에서 먼저 알 수 있게 하기 위함.

현재 이 check가 FAIL이다.

---

# 5. Staging deployment pipeline — 반드시 이해할 것

Current `.github/workflows/deploy-staging.yml` is triggered by:

```text
push to main
workflow_dispatch(ref)
```

Runner:

```text
[self-hosted, linux, x64, chat-staging]
```

Environment:

```text
staging
```

Ordered stages:

1. checkout requested exact revision
2. setup Node 22
3. verify source revision
4. set `chat-v2/staging` pending status
5. require private OpenClaw ingress + token
6. explicitly skip legacy Letta bridge rollout in OpenClaw mode
7. run `scripts/deploy/staging.sh <exact-sha>`
   - strict preflight
   - backup
   - deploy
   - health
   - rollback on failure
8. `scripts/ops/staging-smoke.sh`
   - real Hermes and Letta transport
9. `scripts/ops/openclaw-letta-staging-smoke.sh`
   - same-Conversation session continuity
10. `scripts/ops/staging-browser-smoke.sh`
   - browser links/artifacts/configured QA
11. authenticated `/v1/models` check
   - configured Lucy target must be advertised
12. optional external Cloudflare Access browser smoke
13. publish summaries
14. upload deployment/browser evidence artifact
15. set final `chat-v2/staging` success/failure status

Do not skip stages to make the check green. If a stage is no longer architecturally valid, change the contract deliberately with tests and document why.

---

# 6. Current blockers — split them correctly

## Blocker A — staging Environment contract incomplete

Evidence:

```text
main: 5c15b923...
chat-v2/openclaw-config: FAILURE
run: 31228264406
```

First action:

- read run logs
- identify exact missing/invalid condition
- do not expose secret values

Likely classes supported by gate code:

```text
MISSING_GATEWAY_BASE_URL
MISSING_GATEWAY_TOKEN
INVALID_AGENT_TARGET
EMPTY_SESSION_PREFIX
LOOPBACK_ONLY_GATEWAY_URL
```

이 중 실제 원인은 로그로 확정한다.

## Blocker B — self-hosted staging runner not accepting work

Evidence on PR #102 exact HEAD:

```text
V2 CI: SUCCESS
Agentlucy Runner Service Diagnostic: QUEUED
run: 31238397651
```

This means code/tests can run on GitHub-hosted Actions but host-facing staging workflow cannot currently be relied on.

If helper has agentlucy host access:

1. verify exact unit exists
2. read only service state first
3. start/recover only the Chat staging runner unit if necessary and authorized
4. verify it becomes online and picks up the already-queued diagnostic
5. do not edit runner tokens/config blindly
6. do not install duplicate runner unless the existing registration is proven gone

Historical unit name:

```text
actions.runner.since98kr-chat.ailucy.online.agentlucy-chat-staging.service
```

PR #102 exists for read-only evidence and should not be merged into product main.

## Blocker C — private OpenClaw Gateway reachability/configuration

Even when GitHub variables exist, actual staging container must reach Gateway through a private non-loopback ingress.

Requirements:

- no direct public Cloudflare route to the Gateway
- token server-side only
- `/health` reachable
- `/v1/chat/completions` enabled
- `/v1/models` authenticated listing contains explicit Lucy target

The current Chat repo does not own all OpenClaw runtime setup. Historical PR #100 refers to `since98kr/lucy-openclaw-control` as the control-side dependency. Re-read that repo's **current** reality before changing it; do not rely solely on PR #100's historical statement that replay/interrupt P0 had passed.

## Blocker D — final real Hermes E2E proof

Hermes source parity is merged, but Issue #76 still requires real staging proof:

- Hermes main agent real bounded execution
- approved subagent real bounded conversation
- switching isolation
- tool lifecycle
- generated artifact
- retry/cancel/dedup behavior proportionate to final flow

Do not close #81/#76 solely because PR #86 is merged and its CI was green.

---

# 7. Exact configuration names the helper will encounter

Never print values of secrets.

## OpenClaw / Letta staging

GitHub `staging` Environment variables/secrets used by current workflow:

```text
vars.OPENCLAW_GATEWAY_BASE_URL
secrets.OPENCLAW_GATEWAY_TOKEN
vars.LETTA_OPENCLAW_AGENT_TARGET
vars.LETTA_OPENCLAW_SESSION_PREFIX
vars.LETTA_AGENT_ID
vars.LETTA_TIMEOUT_MS
vars.LETTA_MAX_ARTIFACT_BYTES
vars.LETTA_MAX_ARTIFACT_TOTAL_BYTES
vars.LETTA_MAX_TEXT_ARTIFACT_BYTES
vars.LETTA_ARTIFACT_TOOL_ENABLED
```

Runtime mapping in deploy-staging:

```text
LETTA_BASE_URL   = OPENCLAW_GATEWAY_BASE_URL
LETTA_API_KEY    = OPENCLAW_GATEWAY_TOKEN
LETTA_PROTOCOL   = openclaw
LETTA_CHAT_PATH  = /v1/chat/completions
LETTA_HEALTH_PATH = /health
```

## Hermes staging

```text
vars.HERMES_BASE_URL
vars.HERMES_CHAT_PATH
vars.HERMES_HEALTH_PATH
vars.HERMES_AGENT_ID
secrets.HERMES_API_KEY
vars.HERMES_TIMEOUT_MS
vars.HERMES_PROTOCOL
vars.HERMES_MODEL_MAP_JSON
vars.HERMES_MAX_ARTIFACT_BYTES
vars.HERMES_MAX_ARTIFACT_TOTAL_BYTES
vars.HERMES_ARTIFACT_TOOL_ENABLED
vars.HERMES_ARTIFACT_ENVELOPE_ENABLED
vars.HERMES_DOCKER_NETWORK
```

## Chat staging/security

Representative names:

```text
CHAT_STAGING_ROOT
CHAT_STAGING_DATA_DIR
CHAT_STAGING_PORT
CHAT_PREFLIGHT_STRICT
CHAT_PREFLIGHT_MIN_FREE_BYTES
CHAT_BACKUP_RETENTION
CHAT_PUBLIC_ORIGIN
CHAT_ALLOWED_ORIGIN
CHAT_AUTH_MODE
CHAT_ALLOWED_EMAILS
CHAT_ALLOWED_SERVICE_CLIENT_IDS
CHAT_CF_ACCESS_ISSUER
CHAT_CF_ACCESS_AUD
CHAT_ACCESS_TOKEN
CHAT_RATE_LIMIT_GENERAL
CHAT_RATE_LIMIT_CHAT
CHAT_RATE_LIMIT_UPLOAD
CHAT_MAX_UPLOAD_BYTES
...
```

When checking GitHub Environment, report only presence/shape/status. Do not copy credential values into Issue/PR/chat/log/artifact.

---

# 8. What NOT to resurrect

## 8.1 Direct Letta HMAC proof as OpenClaw release gate

Old work created filesystem/loopback/HMAC probes because standalone Letta headless runtime did not expose local tool lifecycle cleanly.

That was a useful diagnostic journey, but OpenClaw mode moved side-effect execution ownership to the execution fabric.

For OpenClaw mode:

```text
legacy HMAC proof != final completion proof
```

Keep old bridge as rollback/debug evidence until new staging passes; do not make it the primary target again unless the OpenClaw architecture is explicitly rolled back.

## 8.2 README's `OpenClaw is not part of V2` sentence

Current `README.md` still states:

```text
OpenClaw is not part of V2.
```

This is stale relative to merged PR #99/#100. Do not use that sentence as architectural authority.

After staging acceptance stabilizes, README/docs should be reconciled so a new developer is not misled.

## 8.3 Blind implementation from open Issue bodies

Issues #66/#81/#93 contain historical states and earlier completion contracts. Use them for intent/evidence, but Reality priority is:

```text
1. current main
2. merged PRs
3. exact current workflows/config contracts
4. active runtime evidence
5. current CI/status
6. open issue body/comments
7. old chat memory
```

## 8.4 New parallel architecture

Do not rewrite the app around a new state store, new adapter family, new auth system or new artifact system merely to finish staging. Existing contracts are broad and tested; fix the narrow missing boundary first.

---

# 9. Recommended execution plan for the new helper

## Phase 0 — Reality Read only

Before edits:

1. `git fetch --all --prune`
2. inspect current `origin/main`
3. compare with baseline `5c15b923...`
4. list open PRs/issues
5. inspect commit statuses on current main
6. inspect latest staging/config/CI runs
7. inspect whether PR #102 is still needed
8. inspect `since98kr/lucy-openclaw-control` current state if OpenClaw runtime work is required

Output a short Reality record with:

```text
main SHA
open product PRs
staging config status
staging runner availability
OpenClaw Gateway prerequisite state
Hermes runtime availability
next executable action
```

Do not start by coding.

## Phase 1 — Fix Environment readiness

Goal: get `chat-v2/openclaw-config` green without exposing secrets.

Actions:

1. inspect run `31228264406`
2. determine exact failed invariant
3. if missing GitHub variable/secret is the blocker, request/use appropriate operator authority
4. if loopback-only URL is the blocker, establish a private container-reachable ingress from existing approved OpenClaw infrastructure
5. if target mismatch, read `/v1/models` with authenticated operator path and choose explicit Lucy target; do not guess
6. rerun hosted config gate

Acceptance:

```text
current-main chat-v2/openclaw-config == SUCCESS
```

## Phase 2 — Restore staging runner execution

Goal: self-hosted jobs start reliably.

1. inspect existing runner registration/unit state
2. recover existing Chat runner before considering registration
3. prove PR #102 diagnostic (or an equivalent current read-only diagnostic) actually starts
4. prove host/user identity is expected
5. do not read service secret environment or runner credential material

Acceptance:

```text
self-hosted [chat-staging] job reaches RUNNING/SUCCESS
```

## Phase 3 — Exact-main OpenClaw staging deploy

Use current main exact SHA.

Do not deploy a feature branch to call the product accepted unless the workflow is explicitly being used as a temporary diagnostic and final exact-main rerun follows.

Expected gates:

- private Gateway prereq
- strict preflight
- DB backup + verify
- app deploy
- health
- Hermes/Letta transport smoke
- OpenClaw same-conversation continuity smoke
- browser smoke
- `/v1/models` explicit target proof
- optional external Cloudflare QA if enabled
- artifacts/evidence upload

If deployment fails after mutation, use existing rollback; do not improvise destructive recovery.

## Phase 4 — Close Letta/OpenClaw acceptance checklist

Use `docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md` as the starting checklist, but update evidence rather than merely ticking boxes.

Required evidence:

- private `/health`
- target resolves to Lucy
- same conversation same session
- two-turn continuity without full-history replay
- harmless read-only OpenClaw operation
- no duplicate inbound turn
- approval-required side effect denied or properly OpenClaw-approved
- no raw secrets/tool args/private paths to Chat
- attachment input
- generated artifact behavior
- available task/run/session/audit correlation

## Phase 5 — Hermes real acceptance

Use Issue #76, not only old #81 text.

At minimum perform:

### Main agent

- open `[Hermes] Lucy` conversation
- observe verified runtime/capability path
- run harmless real tool action
- verify sanitized lifecycle
- receive artifact if supported/required

### Subagent

- discover approved agents
- explicitly select one approved subagent
- send bounded request
- verify exact selected identity preserved
- create/receive isolated session/tool/artifact state

### Isolation adversarial check

Switch between two approved agents and prove:

- assistant history does not leak
- session IDs do not collide
- idempotency keys are agent-scoped
- artifacts do not cross incorrectly
- tool status does not cross
- permissions/capabilities are selected-agent-specific

## Phase 6 — Unified browser/product regression

Exact-main desktop + mobile:

- login/session
- conversation creation
- Letta conversation
- Hermes conversation
- direct/subagent conversation
- attachments
- artifact rendering/download
- stop/cancel/retry where meaningful
- search/export if touched by changes
- federated path if changes intersect its contracts
- logout/auth regression

Do not rerun every expensive suite after every tiny fix. Use focused tests during iteration, then one full exact-head acceptance run at candidate completion.

## Phase 7 — Documentation and issue hygiene

After actual acceptance only:

1. update README OpenClaw architecture statement
2. reconcile #66 with OpenClaw completion
3. reconcile/close #81 when Hermes staging proof passes
4. mark #93 superseded/not applicable to OpenClaw completion if still open
5. close or label historical #78/#79 appropriately
6. close #76 only after both backend parity tracks and unified acceptance are proven
7. close PR #102 without merge once diagnostic purpose is complete

Avoid false closure based on source merge alone.

## Phase 8 — Production handoff, not automatic deploy

When staging is fully accepted, prepare a production rollout packet containing:

```text
candidate main SHA
staging run ID
artifact IDs/digests
backup/rollback contract
required production vars/secrets by NAME only
Cloudflare/private routing changes
runtime service changes
rollback target
post-deploy smoke plan
```

Then obtain Tei approval before production/customer-impacting action.

---

# 10. Testing strategy

## Focused source checks during implementation

Always run proportionate checks on changed surface.

Examples:

```bash
npm run typecheck
npm test
npm run build
```

For OpenClaw adapter changes:

```bash
npx vitest run server/adapters/openclaw-letta.test.ts
```

For Hermes parity changes, target adapter/capability/collaboration tests first, then full suite.

For shell/deploy changes:

```bash
bash -n <changed-script>
```

and existing nodecheck/contract checks where available.

## Final source candidate

Minimum:

```bash
npm run typecheck
npm test
npm run build
```

plus repository V2 CI.

## Final staging candidate

Must be exact-main and include actual runtime/browser proof. Mock-only/unit-only acceptance is insufficient.

---

# 11. Evidence discipline

Every meaningful finalization step should bind evidence to exact identity.

Recommended record:

```yaml
repository: since98kr/chat.ailucy.online
main_sha: <40-char SHA>
config_gate_run: <id>
staging_run: <id>
runner_state: <sanitized state>
letta_transport: openclaw
openclaw_target: <non-secret target id>
hermes_runtime_identity: <sanitized approved metadata>
browser_artifact: <artifact id/name>
backup_evidence: <non-secret manifest ref>
external_qa: PASS|SKIP|FAIL
unresolved_p0_p1: 0
production_gate: CLOSED|APPROVED
```

Never paste:

- tokens
- cookies
- Authorization headers
- SSH private key
- known_hosts raw contents if it exposes unnecessary host detail
- complete process environment
- raw tool args/results containing private data
- private filesystem content

---

# 12. Safety and authority boundary

The new helper is expected to push development forward aggressively but must preserve these gates.

## Allowed without product-direction redesign

- GitHub Reality Read
- source code diagnosis
- branch creation
- focused code fixes
- tests/build
- Draft PR
- CI fixes
- read-only staging/host diagnostics
- sanitized evidence
- rollback of a failed action when already part of the approved execution contract

## Requires Tei approval before actual action

- production deployment
- customer-impacting routing/config change
- secret/credential creation/replacement or permission expansion
- runner registration if existing runner cannot be recovered
- persistent service install/replacement where it changes operational boundary
- destructive DB migration/data deletion
- force push / branch protection bypass
- live external action

Do not interpret "finish Chat" as blanket permission to weaken these controls.

---

# 13. High-risk mistakes to avoid

1. **Do not debug config-gate failure by changing application code first.**
2. **Do not treat queued self-hosted job as a failing test.** It is an execution availability issue.
3. **Do not expose Gateway token to browser code.**
4. **Do not use public Cloudflare routing directly for OpenClaw Gateway.**
5. **Do not silently select default OpenClaw agent.** Use explicit Lucy target.
6. **Do not replay full transcript into persistent OpenClaw session.**
7. **Do not resurrect direct Letta HMAC proof as the OpenClaw release criterion.**
8. **Do not close #76 from source CI alone.**
9. **Do not assume Issue #81's old SHA is current.**
10. **Do not merge PR #102.** It is diagnostic evidence only.
11. **Do not perform `docker compose down` globally.**
12. **Do not reset/delete Chat SQLite to make staging pass.**
13. **Do not disable fail-closed capability checks to get green E2E.**
14. **Do not conflate Letta cognition with OpenClaw execution ownership.**
15. **Do not let subagent selection become authorization-by-mention.** Agent must be approved/visible.

---

# 14. Key files to read before editing

## Architecture/product

```text
README.md
docs/PRODUCT_SPEC_V2.md
docs/BACKEND_ADAPTERS.md
docs/GS8_FEDERATED_WORKFLOW.md
```

Note: README's `OpenClaw is not part of V2` statement is stale.

## OpenClaw/Letta

```text
docs/OPENCLAW_LETTA_CHAT_MIGRATION.md
docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md
server/adapters/openclaw-letta.ts
server/adapters/openclaw-letta.test.ts
server/adapters/openclaw-letta.contract.md
server/adapters/index.ts
```

## Staging/deployment

```text
.github/workflows/openclaw-staging-config-gate.yml
.github/workflows/deploy-staging.yml
.github/workflows/staging-preflight.yml
compose.staging.yml
scripts/deploy/staging.sh
scripts/ops/staging-preflight.sh
scripts/ops/staging-smoke.sh
scripts/ops/openclaw-letta-staging-smoke.sh
scripts/ops/staging-browser-smoke.sh
scripts/ops/external-staging-browser-smoke.sh
```

## Hermes parity

Locate current versions of:

```text
server/adapters/capability-contract.ts
server/adapters/http.ts
server/adapters/http-federation.ts
server/collaboration-runner.ts
tests/hermes-cli-parity.contract.test.ts
```

Do not use PR #86 old branch version when main has moved; inspect current main files.

## Security/recovery

```text
docs/BROWSER_AUTH_AND_STATUS.md
docs/SECURITY_AND_RECOVERY.md
docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md
docs/HOME_SERVER_STAGING_SETUP.md
```

---

# 15. Key GitHub records

## Canonical completion

```text
Issue #76 — Complete Chat with both Letta CLI parity and Hermes CLI parity
```

## Letta historical/current intent

```text
Issue #66 — Letta CLI/runtime parity historical implementation + staging intent
Issue #93 — old direct Letta local-tool proof; now stale for OpenClaw release path
PR #99 — OpenClaw-backed Letta transport merged
PR #100 — staging cutover to OpenClaw-backed Letta Lucy merged
PR #101 — hosted OpenClaw staging config gate merged
```

## Hermes

```text
Issue #81 — Hermes CLI parity intent; body contains historical branch/HEAD
PR #86 — Hermes parity implementation merged
```

## Execution diagnostics

```text
PR #102 — read-only agentlucy runner diagnostic, open, DO NOT MERGE
run 31238397651 — queued self-hosted diagnostic
run 31238397630 — V2 CI success on same diagnostic HEAD
```

## Current main OpenClaw config status

```text
main 5c15b923668b8a1116eb82444814b047e4d4588c
chat-v2/openclaw-config FAILURE
run 31228264406
```

---

# 16. Suggested first status update from the new helper

After doing the Reality Read, report in this exact spirit:

```text
CHAT FINALIZATION REALITY

Main: <sha>
Source CI: <state>
OpenClaw config gate: <state + exact non-secret failure class>
Chat staging runner: <online/offline/queued + evidence>
Private Gateway: <reachable/unreachable/not-configured, no secret values>
OpenClaw Lucy target: <advertised/not-advertised/not-checkable>
Hermes runtime: <reachable/unreachable/not-checkable>
Blocking layer: CONFIG | RUNNER | OPENCLAW_RUNTIME | HERMES_RUNTIME | APP_CODE | BROWSER_E2E

Next action:
<one smallest executable action>
```

The point is to prevent broad speculative refactoring.

---

# 17. Final completion report expected from the helper

Do not return "done". Return a structured closeout.

```text
CHAT FINALIZATION COMPLETE

1. Exact source
- repository
- main SHA
- final PRs/commits

2. CI
- V2 CI
- config gate
- relevant focused workflows

3. Staging deployment
- exact run ID
- exact deployed SHA
- backup/health/rollback state

4. Letta/OpenClaw acceptance
- private health
- explicit target
- 2-turn continuity
- no duplicate replay
- harmless execution
- attachments
- generated artifacts
- redaction/audit linkage

5. Hermes acceptance
- main agent runtime identity
- capability handshake
- harmless tool execution
- artifact
- cancel/retry/dedup

6. Hermes subagent acceptance
- approved discovery
- explicit selection
- real conversation
- isolation switching test

7. Browser
- desktop
- mobile
- authentication
- export/attachments/artifacts

8. Security
- no secret leakage
- no authorization weakening
- no destructive data action

9. GitHub hygiene
- #66/#81/#93/#76 current disposition
- PR #102 disposition
- stale docs corrected

10. Production
- NOT DEPLOYED unless separately approved
- exact production rollout packet ready
```

---

# 18. Bottom line

The project is close enough that a strong helper can finish it, but the correct job is **not "build more Chat features"**. The job is:

```text
1. restore trustworthy staging execution,
2. wire the private OpenClaw environment correctly,
3. prove current exact-main Letta/OpenClaw behavior,
4. prove current exact-main Hermes + subagent behavior,
5. run unified browser acceptance,
6. clean stale GitHub/docs state,
7. prepare production approval packet.
```

Prioritize runtime truth and user-visible proof over additional architecture work.

If current GitHub/host reality contradicts this handoff, current reality wins. Record the contradiction explicitly before changing direction.
