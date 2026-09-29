# chat.ailucy.online V2

A private Web/PWA chat interface for Tei's OpenClaw and Hermes agent systems.

> **Identity migration note (2026-09):** The canonical cognitive identity is now
> `[OpenClaw] Lucy`. The former `[Letta] Lucy` identity has been retired to a
> legacy fallback and is preserved only until the OpenClaw path fully clears
> exact-main staging. Runtime data (conversations, authorized agents) already
> ships as `[OpenClaw] Lucy`; this document is aligned to that shipped runtime.

## Product model

```text
System
└── Conversation
    └── Participant / Agent
```

- **OpenClaw** hosts `[OpenClaw] Lucy` as the canonical cognitive identity and preserves approved long-term personal memory across separated Conversations.
- **Hermes** contains `[Hermes] Lucy`, Xixi, Lynn, Gemma, and an expandable agent registry.
- **Conversations** are cognitive workspaces: create, rename, pin, archive, trash, full-content search, branch, and export.
- Hermes participation is explicit per Conversation; registration never means automatic invocation.
- Federated Conversations are explicitly enabled and coordinate selected OpenClaw/Hermes lanes without unrestricted memory sharing.
- The legacy Letta native bridge remains available as a fallback lane and is not removed until the OpenClaw path passes exact-main staging.

## Runtime boundary

`[OpenClaw] Lucy` is the cognitive identity. OpenClaw is also the execution fabric behind that identity. OpenClaw owns execution-runtime concerns (workers, tools, tasks, scheduler, approvals, audit); it does not fabricate Lucy's judgment or long-term memory contract.

```text
Chat V2
  -> [OpenClaw] Lucy conversation identity
  -> private OpenClaw Gateway agent endpoint
  -> OpenClaw-backed Lucy cognition/session
  -> OpenClaw execution fabric
       workers / tools / tasks / scheduler / approvals / audit
```

- Selected explicitly with `OPENCLAW_PROTOCOL=openclaw` (legacy `LETTA_PROTOCOL=openclaw` is still honored as a fallback); the Gateway stays on loopback, tailnet, or another private authenticated ingress.
- `OPENCLAW_AGENT_TARGET` (legacy `LETTA_OPENCLAW_AGENT_TARGET`) is mandatory, so `[OpenClaw] Lucy` is never routed to whichever OpenClaw agent happens to be the current default.
- Side-effecting execution belongs to the OpenClaw policy, approval, and audit surfaces rather than to a direct shell.
- The legacy native Letta bridge remains available as a fallback and is not removed until the OpenClaw path passes exact-main staging.
- Acceptance criteria and rollout order: [`docs/OPENCLAW_LETTA_CHAT_MIGRATION.md`](docs/OPENCLAW_LETTA_CHAT_MIGRATION.md), [`docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md`](docs/OPENCLAW_LETTA_CHAT_ACCEPTANCE.md).

## Current capabilities

### Conversation and chat

- SQLite persistence with WAL and foreign-key enforcement.
- Optimistic user messages and normalized streaming events.
- Stop, failure, and persisted message states.
- Separate active, archived, and trashed lists.
- Search across titles, previews, message bodies, and filenames.
- Branch from a selected message while retaining source lineage, participants, and federation boundary.
- Markdown transcript, collaboration, Capsule, and workflow-evidence export.

### Hermes multi-agent collaboration

- Persistent agent registry with roles, descriptions, capabilities, enabled state, and direct-chat policy.
- Conversation-scoped participants with lead, participant, and observer roles.
- Direct Conversations with Xixi, Lynn, or Gemma from the system navigation.
- Explicit `@Xixi`, `@Lynn`, and `@Gemma` routing from `[Hermes] Lucy` Conversations.
- Original subagent messages remain visible and are never replaced by Lucy summaries.
- Participant state and team activity are persisted for later inspection.
- Team panel supports participant changes, direct-chat entry, routing visibility, and activity history.
- One agent failure does not erase completed outputs from other agents.
