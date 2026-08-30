# Lucy Chat Scenario Audit — 2026-08-30

Issue: #199
Base truth: `main` @ `e022f0ea39e07a4181ea7ad96b5761b9f55d971b`
Status: H0/H1/H2 audit in progress — no production/runtime mutation

## Outcome

Restore Lucy Chat as a coherent personal 1:1 working conversation with real Lucy orchestration. The user should not have to reason about backend transport, federation, worker envelopes, or internal execution events to continue normal work.

## Current-source findings

### F1 — The root application still composes multiple product eras

`src/App.tsx` wires all of the following into the primary app shell:

- `useChat`
- `useCollaboration`
- `useFederation`
- `TeamPanel`
- `FederationPanel`
- direct agent entry
- federated-conversation creation

This makes multi-agent/federated machinery part of the default conversation surface rather than an isolated optional runtime concern.

Impact: HIGH. It increases state combinations and makes it easy for a normal 1:1 Lucy turn to inherit team/federation semantics.

### F2 — Fresh Chat defaults to Hermes, not personal Lucy

`src/useChat.ts` initializes:

```ts
const [selectedSystem, setSelectedSystem] = useState<SystemId>('hermes');
const [activeAgent, setActiveAgent] = useState(defaultAgent.hermes);
```

A fresh page therefore begins in the collaborative Hermes model, even though the recovery outcome is personal Lucy-first 1:1 chat.

Impact: HIGH. Fresh-conversation semantics are already wrong before the user sends the first message.

### F3 — Existing E2E tests validate the old interaction model

`e2e/chat.spec.ts` makes Hermes team/federated flows first-class acceptance cases:

- default header expects `[Hermes] Lucy`;
- direct Xixi conversation;
- Hermes multi-agent mentions;
- Team Activity panel;
- federated Conversation + Memory Capsule workflow;
- mobile Hermes team panel;
- mobile federated panel.

These tests may be internally correct for the older design, but they do not verify the critical natural-language operating scenarios in #199:

- `계속해`
- `지금 어디까지야?`
- `왜 안돼?`
- `승인`
- continuation after reload/retry
- exact approval binding
- fact/inference/unknown separation
- blocker + next action recovery

Impact: HIGH. CI can be green while the actual user experience is incoherent.

### F4 — Product spec and current recovery intent are in conflict

`docs/PRODUCT_SPEC_V2.md` still defines a two-system product with Phase 2 Hermes team chat and Phase 3 federated conversations. Current #199 product intent is a personal, single-user, mobile-first 1:1 Lucy messenger/PWA with real Lucy orchestration and without making multi-agent/federation the primary product surface.

This is a specification conflict, not merely a UI bug.

Decision required inside this Work Package: make the current 1:1 Lucy contract canonical and explicitly demote/scope the legacy Team/Federation product model rather than allowing both to silently define the root experience.

### F5 — Message streaming is transport-oriented, not task-state-oriented

`src/useChat.ts` maintains:

- conversation transcript;
- transient `runStatus`;
- streaming state;
- artifact deliveries;
- execution transcript events.

It does not maintain a user-facing durable concept of:

- active task/work item;
- pending approval identity;
- blocker identity;
- last verified status snapshot;
- continuation target;
- next action.

As a result, phrases such as `계속해` or bare `승인` are delegated to model inference without a Chat-level binding contract.

Impact: CRITICAL for S2/S3/S5/S6.

### F6 — Bare approval has no Chat-level correlation contract

The current client send contract provides message/session/artifact/workflow information, but there is no explicit pending-approval identifier bound to the user turn at the Chat state-machine level.

Required behavior for #199: a bare `승인` may authorize only one current, unexpired, unambiguous approval boundary; otherwise it must fail closed.

### F7 — Conversation identity and agent identity are coupled inconsistently

`openAgentConversation()` may reuse an existing active conversation purely by matching `agentId`. `switchSystem()` and direct-agent actions change selected system/agent independently from task intent. This can be useful for legacy multi-agent UX, but it expands the risk that user-visible selection and actual continuation target diverge.

Required behavior: visible identity must bind to the actual backend/session identity for every turn.

## Scenario gap matrix — initial source audit

| Scenario | Current source evidence | Initial verdict | Primary gap |
|---|---|---|---|
| S1 Fresh/vague request | Fresh defaults to Hermes | FAIL | wrong default product identity |
| S2 `계속해` | no durable continuation target contract | FAIL | model-only inference |
| S3 status/truth | transcript/runStatus only | PARTIAL | no fact/inference/unknown/blocker schema |
| S4 safe executable work | runtime can execute, but Chat has no task continuation contract | PARTIAL | execution not bound to durable task state |
| S5 approval boundary | runtime policy exists | PARTIAL | Chat does not surface a canonical pending approval object |
| S6 bare `승인` | no explicit approval correlation in client state | FAIL | ambiguous authorization risk |
| S7 progress | run/tool transcript exists | PARTIAL | transport events can dominate conversation UX |
| S8 failure/recovery | generic error + run.failed exists | PARTIAL | no blocker/next-action state |
| S9 artifacts | mature artifact contract exists | PASS_WITH_NOTE | must bind artifact to active task context |
| S10 continuity | conversation/session/retry support exists | PARTIAL | active task/approval may not survive coherently |
| S11 worker identity | multiple selectors/routes exist | PARTIAL | need route/session proof per visible selection |
| S12 memory behavior | legacy federation/memory-capsule UI exists | FAIL/PARTIAL | UI semantics may exceed actual Lucy memory contract |

## Minimum architecture correction — proposed H2 direction

Do **not** build a second controller or fake memory system.

Introduce one small, explicit **conversation operating context** bound to the existing Conversation/backend session. It should be transport-agnostic and contain only user-facing orchestration state that Chat must know deterministically:

```text
ConversationOperatingContext
- conversation_id
- backend_system
- agent_id
- session_identity (opaque/non-secret)
- active_task_id? / active_task_label?
- continuation_target?
- status_truth? (fact/inference/unknown fields or canonical status ref)
- blocker?
- next_action?
- pending_approval? {
    approval_id,
    kind,
    summary,
    expires_at?,
    state
  }
```

Important boundaries:

- OpenClaw/Letta/Hermes remain authoritative for actual execution and policy.
- Chat stores/binds only enough state to make user turns unambiguous.
- Chat never fabricates approval success.
- `승인` resolves only through `pending_approval.approval_id` and current conversation/session identity.
- `계속해` resolves through the active continuation target; if no verified target exists, Lucy says so instead of inventing one.
- backend/task status facts should be refreshed from their canonical owner before consequential actions.

## First implementation slice after audit

1. Make personal Lucy the explicit default entry contract.
2. Isolate legacy Team/Federation affordances from the default 1:1 path; do not delete runtime capability blindly.
3. Add a typed conversation operating-context contract to shared/server/client boundaries.
4. Bind one pending approval object and one continuation target to a conversation.
5. Add deterministic tests for:
   - continuation binding;
   - approval binding/expiry/ambiguity;
   - identity mismatch rejection;
   - blocker + next-action recovery;
   - reconnect/retry persistence.
6. Replace/add browser scenarios around real user phrases before broader UI redesign.

## Forbidden implementation shortcuts

- canned responses keyed on Korean QA phrases;
- fake/deterministic Lucy;
- duplicate broker/controller/memory subsystem;
- authorization inferred from assistant prose alone;
- treating green transport health as scenario acceptance;
- deleting Hermes/Federation runtime code before confirming which pieces remain required by separate backend-parity work.

## Current verdict

`BLOCKED_FOR_IMPLEMENTATION_PLAN_FINALIZATION`, not because code cannot be written, but because the product-model conflict must be made explicit first. The smallest credible fix is a 1:1 Lucy-first root flow plus a typed operating-context contract; broad UI rewrites are not justified yet.
