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

Implemented in the current v1.5 branch:

- copy user or assistant message content;
- retry a failed or cancelled direct response without duplicating the user message;
- regenerate a completed assistant response while preserving the original response;
- run only the original response agent against history ending at the source user message;
- persist original response, source message, new output, mode, status, error, and idempotency key;
- replay a completed retry for the same idempotency key without creating another response;
- block direct-message retry inside a federated Conversation and retain workflow resume as the only recovery path;
- expose the response action and persistent `재생성 N` lineage label on desktop and mobile.

### 3. Evidence export — P1

v1.5 provides two complementary exports:

- Markdown for human-readable sharing;
- sanitized JSON for machine-readable evidence and later migration.

The authenticated server-generated JSON export contains Conversation metadata, messages, public artifact metadata, participants, activity, retry/regeneration lineage, federation configuration, Capsules, every workflow run, and every persisted workflow event. Server storage paths and secrets are excluded.

### 4. File-aware UX — P1

Attachment state must be visible as a lifecycle rather than one generic paperclip state:

1. uploading;
2. uploaded and waiting for the next message;
3. attached to the sent message;
4. delivering to each selected backend;
5. delivered to the backend, without claiming model understanding;
6. unsupported or failed;
7. returned by AI.

The backend-neutral `artifacts.delivery` contract is implemented and verified in the integrated multimodal path. The integrated v1.5 UI consumes the same contract rather than maintaining duplicate delivery semantics.

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
| Multimodal core | server adapters, artifact service, runners, delivery contract | owns backend artifact semantics |
| v1.5 UX/export | message stream, retry route, evidence export, browser tests | consumes the shared delivery contract |
| Release E2E | staging and external Playwright tests | requires exact-head backend and UI evidence |

## Completed v1.5 slices

### Slice A — Message actions and evidence

- message copy action;
- visible AI-generated file provenance;
- authenticated JSON evidence export;
- existing Markdown export retained.

### Slice B — Retry and regeneration

- direct response retry and regeneration;
- original transcript preservation;
- source-message deduplication;
- idempotent replay;
- retry audit table and JSON evidence;
- desktop and mobile browser coverage;
- complete type, API, browser, authentication, build, container, and recovery CI pass.

### Slice C — Multimodal delivery lifecycle

- per-agent `artifacts.delivery` events;
- distinct delivering, delivered, unsupported, and failed states;
- backend delivery is never presented as model understanding;
- generated text and PNG files are persisted and byte-verified;
- unsupported binary input is rejected before the backend call.

## Remaining release gates

- render the integrated delivery lifecycle in the browser transcript;
- run exact-head integration CI;
- deploy to isolated staging only after explicit approval;
- verify real Letta PDF understanding and Hermes image understanding;
- verify generated-file return with the actual selected model;
- repeat required tests through Cloudflare Access.

## Out of scope

- voice or telephone integration;
- broad UI redesign;
- unrestricted cross-Conversation memory sharing;
- drive.ailucy.online as a hard runtime dependency;
- production routing or deployment without explicit approval.
