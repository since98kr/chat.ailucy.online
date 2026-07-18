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
- **Conversations** are cognitive workspaces: create, rename, pin, archive, trash, full-content search, branch, and export.

OpenClaw is not part of V2.

## Current capabilities

### Conversation and chat

- SQLite persistence with WAL and foreign-key enforcement.
- Optimistic user messages and normalized streaming events.
- Stop, failure, and persisted message states.
- Separate active, archived, and trashed lists.
- Search across titles, previews, message bodies, and filenames.
- Branch from a selected message while retaining source lineage.
- Markdown transcript export.

### Files and images

- Drag and drop, file picker, and clipboard image paste.
- Per-file upload progress and pending attachment state.
- Attach files to the next user message.
- Inline images, fullscreen content, and original downloads.

### Backend systems

- Independent Letta and Hermes adapter boundaries.
- Deterministic mock mode for development.
- Configurable HTTP mode with health probes.
- NDJSON, SSE, OpenAI-compatible, simple JSON, and plain-text stream normalization.
- No silent fallback when a configured real backend is unhealthy.
- Local compatibility tests verify bearer authentication and backend-neutral Conversation payloads.

### Smartphone and PWA

- Installable PWA manifest and app icon.
- Standalone smartphone metadata and safe-area viewport support.
- Offline application shell for reopening the interface.
- `/api` requests and AI responses are never cached by the service worker.

### Security and recovery

- Cloudflare Access identity mode for the private production service.
- Optional bearer-token API mode for controlled non-browser access.
- Cross-origin mutation protection, route-class rate limits, and browser security headers.
- Online SQLite backup plus artifact checksum manifest.
- Pre-deployment backup verification before staging replacement.
- Retained backup policy and confirmation-gated restore with rescue rollback.

### Runtime and automation

- Unified Web/API production container.
- GitHub Actions typecheck, API, adapter, security, backup, production build, Compose, and runtime tests.
- Real Chromium regression at 1280×900 desktop and 390×844 mobile sizes.
- Automated horizontal-overflow checks and retained desktop/mobile screenshots.
- Isolated localhost staging Compose service.
- Repository-scoped self-hosted runner bootstrap with verified Docker access.
- Revision-tagged staging deployments with backup, health validation, and automatic image rollback.

Production deployment and Cloudflare routing are not enabled.

## Development

```bash
npm install
npm run dev
```

Validation:

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Container preview:

```bash
docker build -t chat-ailucy-v2:local .
docker run --rm -p 127.0.0.1:4174:4174 -v chat-v2-data:/data chat-ailucy-v2:local
```

Backup inside a built container:

```bash
node dist-server/backup.js create
node dist-server/backup.js verify /data/backups/<backup-id>
```

## Documentation

- [`docs/PRODUCT_SPEC_V2.md`](docs/PRODUCT_SPEC_V2.md)
- [`docs/BACKEND_ADAPTERS.md`](docs/BACKEND_ADAPTERS.md)
- [`docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md`](docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md)
- [`docs/SECURITY_AND_RECOVERY.md`](docs/SECURITY_AND_RECOVERY.md)
- [`config/adapters.env.example`](config/adapters.env.example)
