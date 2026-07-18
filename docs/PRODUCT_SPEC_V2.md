# chat.ailucy.online V2 — Product Specification

## Product goal

A private Web/PWA chat interface for communicating with two distinct backend agent systems without flattening their identities or memory models.

- **Letta**: a persistent personal relationship with `[Letta] Lucy`.
- **Hermes**: a collaborative agent system led by `[Hermes] Lucy`, expandable with Xixi, Lynn, Gemma, and future subagents.

The system is optimized for a single user. It must reduce cognitive load by separating agendas into explicit Conversations.

## Information architecture

```text
System
└── Conversation
    └── Participant / Agent
```

### Letta

```text
Letta
└── [Letta] Lucy · Personal
    ├── Conversation A
    ├── Conversation B
    └── Conversation C
```

Conversation boundaries separate agendas, while `[Letta] Lucy` retains approved long-term personal memory across Conversations.

### Hermes

```text
Hermes
├── [Hermes] Lucy · Lead
├── Xixi · Implementation
├── Lynn · Independent Review
└── Gemma · Multimodal
```

Each Hermes Conversation starts with `[Hermes] Lucy`. Subagents may be added per Conversation in Phase 2. Registration in Hermes does not imply participation in every Conversation.

## Approved UI direction

- Compact dark UI based on design concept 5.
- Maximum desktop frame width: approximately 1180–1280 px.
- Left sidebar combines Systems and Conversations.
- Central chat is the primary workspace.
- Workspace Map is not permanently visible.
- Team Activity opens as a temporary panel only when needed.
- Message text width is constrained for readability; images, tables, and code may use a wider content width.
- Mobile prioritizes the active Conversation and uses a drawer for navigation.

## Conversation lifecycle

Required Phase 1 states:

- Active
- Pinned
- Archived
- Trashed
- Permanently deleted

Required actions:

- Create a Conversation in the selected System.
- Generate a title from the first message.
- Rename.
- Pin/unpin.
- Archive/restore.
- Move to Trash/restore.
- Permanently delete.
- Search title, messages, and filenames.
- Preserve per-Conversation drafts and last-read position.
- Branch from a selected message into a new Conversation.
- Export to Markdown in Phase 1; PDF/JSON/ZIP may follow.

Conversation transcript deletion, artifact deletion, and long-term memory deletion are separate operations.

## Phase plan

### Phase 1 — Reliable one-to-one chat

- `[Letta] Lucy` one-to-one chat.
- `[Hermes] Lucy` one-to-one chat.
- Conversation management.
- Streaming, stop, retry, reconnect, and optimistic user messages.
- Desktop and smartphone synchronization.
- Drag-and-drop files.
- Clipboard image paste.
- Inline images.
- Downloadable file cards.
- PWA foundation.

### Phase 2 — Hermes team chat

- Direct chats with Hermes subagents.
- Add/remove subagents per Conversation.
- Team rooms and explicit mentions.
- Collapsible Team Activity.
- Original subagent outputs remain inspectable; Lucy summaries do not replace source results.

### Phase 3 — Federated conversations

- Conversations containing agents from different backend systems.
- Deterministic Conversation Controller for routing, ordering, and memory-sharing boundaries.
- Explicit Memory Capsules for cross-system memory exchange.

## File and image behavior

### Input

- Desktop drag and drop.
- File picker.
- Multiple attachments.
- Clipboard image paste.
- Mobile camera, photo library, and file picker.
- Preview before sending.
- Upload progress, cancel, and retry.

### Output

- Images display directly in the Conversation.
- Images support fullscreen, copy, and original download.
- Documents and code display as compact file cards.
- Runtime artifacts are stored by the Chat Artifact Service.
- `drive.ailucy.online` is for durable publication/archival, not a hard runtime dependency.
- GitHub is the source of truth for version-controlled code.

## Safety and execution

Harness controls irreversible actions rather than prescribing how agents think.

Machine-enforced boundaries include:

- File and directory permissions.
- Secret access.
- External network access.
- Delete and overwrite operations.
- Commit, push, deployment, and service restart.
- Evidence, test results, and rollback.

Letta prioritizes efficient production through one responsible Lucy. Hermes preserves cognitive autonomy and independent disagreement while restricting irreversible execution.
