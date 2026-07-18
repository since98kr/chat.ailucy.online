# chat.ailucy.online V2

A private Web/PWA chat interface for Tei's Letta and Hermes agent systems.

## Product model

```text
System
└── Conversation
    └── Participant / Agent
```

- **Letta** contains `[Letta] Lucy · Personal` and preserves approved long-term personal memory across separated Conversations.
- **Hermes** contains `[Hermes] Lucy` and is expandable with Xixi, Lynn, Gemma, and future subagents.
- **Conversations** are first-class cognitive workspaces: create, rename, pin, archive, trash, search, branch, and export.

## Current milestone

Phase 1 UI foundation on `agent/chat-v2-foundation`:

- Approved compact dark design.
- System and agent hierarchy.
- Conversation-first navigation.
- Responsive desktop/mobile structure.
- Inline image and downloadable file presentation.
- Optional Hermes Team Activity panel.
- GitHub Actions typecheck/build workflow.

## Development

```bash
npm install
npm run dev
```

Validation:

```bash
npm run typecheck
npm run build
```

## Documentation

- [`docs/PRODUCT_SPEC_V2.md`](docs/PRODUCT_SPEC_V2.md)
- [`docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md`](docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md)

OpenClaw is not part of V2.
