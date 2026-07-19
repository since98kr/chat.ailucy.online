# Chat V2 v1.5 — Reliable AI Workbench

## Release objective

v1.5 turns the deployed Conversation-centered chat foundation into a dependable daily workbench. It does not reopen the approved information architecture or replace the current visual design.

The release is successful when Tei can send context, understand what the AI actually received, recover from failed work, and take generated results out of Chat V2 without inspecting implementation details.

## Release tracks

### 1. Multimodal input and generated artifacts — P0

Tracked by Issue #47 and its dedicated implementation PR.

- documents and images become model input rather than storage-only attachments;
- unsupported formats fail explicitly;
- AI-created files return as authenticated Conversation artifacts;
- local and public staging tests verify understanding, not merely upload/download.

### 2. Message operations — P1

- copy user or assistant message content;
- retry a failed run without duplicating the user message;
- regenerate a selected assistant response while preserving lineage;
- make failed and cancelled states understandable and recoverable.

### 3. Evidence export — P1

v1.5 provides two complementary exports:

- Markdown for human-readable sharing;
- sanitized JSON for machine-readable evidence and later migration.

The JSON export contains Conversation metadata, messages, public artifact metadata, participants, activity, routing, federation configuration, Capsules, workflow runs, and available workflow events. Server storage paths and secrets are excluded.

### 4. File-aware UX — P1

Attachment state must be visible as a lifecycle rather than one generic paperclip state:

1. uploading;
2. uploaded and waiting for the next message;
3. attached to the sent message;
4. delivered to the selected backend;
5. unsupported or rejected;
6. returned by AI.

### 5. Release quality — P0

- exact-head CI;
- desktop Chromium regression;
- mobile Chromium regression;
- authenticated browser regression;
- container and recovery smoke;
- isolated staging deployment evidence;
- public Cloudflare Access E2E when required;
- no production deployment without a separate approval gate.

## Parallel development lanes

| Lane | Main files | Conflict policy |
|---|---|---|
| Multimodal core | server adapters, artifact service, runners | owns backend artifact contract |
| v1.5 UX/export | message stream, header, browser tests | avoids adapter and runner files |
| Release E2E | staging and external Playwright tests | begins after contracts stabilize |

## Current first slice

- message copy action;
- visible AI-generated file provenance;
- sanitized JSON evidence export;
- existing Markdown export retained.

## Out of scope

- voice or telephone integration;
- broad UI redesign;
- unrestricted cross-Conversation memory sharing;
- drive.ailucy.online as a hard runtime dependency;
- production routing or deployment without explicit approval.
