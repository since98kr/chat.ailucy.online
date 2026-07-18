# Giant Step 8 — Federated Workflow

## Overview

A federated Conversation is an explicit workspace coordinated by `[Hermes] Lucy`. Existing single-system Conversations continue to use their original execution path.

```text
Parallel group 0
├─ selected Letta lane
└─ selected Hermes worker lanes

Parallel group 1
└─ [Hermes] Lucy synthesis
```

Only selected or mentioned agents execute. Independent steps run concurrently. The coordinator starts after the selected worker steps terminate.

## Memory Capsules

Cross-system context is transferred only through Memory Capsules.

- `draft`: visible in the control panel but not delivered to an adapter;
- `approved`: delivered only to its declared target system;
- `revoked`: retained for audit and no longer delivered.

Each Capsule records its source and target systems, content, source message references, creator, approver, and timestamps. A revoked Capsule cannot be re-approved; a new Capsule must be created.

## Durable workflow ledger

SQLite stores:

- federation configuration per Conversation;
- Memory Capsules;
- workflow runs and idempotency keys;
- steps, dependencies, attempts, output messages, and errors;
- append-only sequenced workflow events.

Agent outputs are stored as separate transcript messages. Lucy synthesis does not replace worker originals.

## Idempotency

The same Conversation and idempotency key identify one durable run. A repeated completed request returns the existing run and does not create duplicate transcript messages.

## Pause and resume

When a connection closes during execution, the run becomes `paused`. Completed steps remain completed. Resume retries only failed, cancelled, or pending steps and increments their attempt count. Coordinator synthesis runs after required steps terminate.

## Partial failure

A worker failure does not erase completed outputs from other workers. The coordinator may synthesize available evidence and the run retains its partial-failure note. A coordinator failure leaves the run resumable.

## Adapter request

A federated adapter request includes:

- target agent and system;
- workflow run identity;
- routing mode;
- agent capabilities;
- approved Capsules for the target system;
- current Conversation transcript.

Draft and revoked Capsules are excluded.

## User controls

The UI supports:

- creating a federated Conversation;
- choosing parallel targets;
- creating, approving, and revoking Capsules;
- inspecting runs, steps, groups, attempts, and errors;
- resuming paused or failed runs;
- reading the event ledger on desktop and mobile.

## Current boundary

This phase does not deploy the service and does not enable automatic external actions. Federation must be enabled per Conversation.
