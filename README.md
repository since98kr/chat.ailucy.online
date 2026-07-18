# chat.ailucy.online V2

A private Web/PWA chat interface for Tei's Letta and Hermes agent systems.

## Product model

```text
System
└── Conversation
    └── Participant / Agent
```

- **Letta** contains `[Letta] Lucy · Personal` and preserves approved long-term personal memory across separated Conversations.
- **Hermes** contains `[Hermes] Lucy`, Xixi, Lynn, Gemma, and an expandable agent registry.
- **Conversations** are cognitive workspaces: create, rename, pin, archive, trash, full-content search, branch, and export.
- Hermes participation is explicit per Conversation; registration never means automatic invocation.

OpenClaw is not part of V2.

## Current capabilities

### Conversation and chat

- SQLite persistence with WAL and foreign-key enforcement.
- Optimistic user messages and normalized streaming events.
- Stop, failure, and persisted message states.
- Separate active, archived, and trashed lists.
- Search across titles, previews, message bodies, and filenames.
- Branch from a selected message while retaining source lineage and participant configuration.
- Markdown transcript and collaboration-evidence export.

### Hermes multi-agent collaboration

- Persistent agent registry with roles, descriptions, capabilities, enabled state, and direct-chat policy.
- Conversation-scoped participants with lead, participant, and observer roles.
- Direct Conversations with Xixi, Lynn, or Gemma from the system navigation.
- Explicit `@Xixi`, `@Lynn`, and `@Gemma` routing from `[Hermes] Lucy` Conversations.
- Deterministic execution order: explicitly targeted subagents first, `[Hermes] Lucy` synthesis last.
- Original subagent messages remain visible and are never replaced by Lucy summaries.
- Participant state and team activity are persisted for later inspection.
- Team panel supports participant changes, direct-chat entry, routing visibility, and activity history.
- One agent failure does not erase already completed outputs from other agents.
- No automatic external tool execution or irreversible action is enabled by collaboration routing.

### Files and images

- Drag and drop, file picker, and clipboard image paste.
- Per-file upload progress and pending attachment state.
- Attach files to the next user message.
- Inline images, fullscreen content, and original downloads.

### Backend systems

- Independent Letta and Hermes adapter boundaries.
- Deterministic mock mode for local development.
- Configurable HTTP mode with health probes.
- Target-agent, participant capability, and routing metadata for Hermes HTTP adapters.
- NDJSON, SSE, OpenAI-compatible, simple JSON, and plain-text stream normalization.
- No silent fallback when a configured real backend is unhealthy.
- Strict staging requires both real adapters to be configured and healthy.

### Smartphone and PWA

- Installable PWA manifest and app icon.
- Standalone smartphone metadata and safe-area viewport support.
- Offline application shell for reopening the interface.
- `/api` requests and AI responses are never cached by the service worker.
- Hermes mention controls and the temporary Team panel remain within the approved mobile frame.

### Security and recovery

- Cloudflare Access identity mode for the private browser service.
- Private token login that exchanges the access value for an HttpOnly, SameSite browser session.
- The raw access value is not retained in browser JavaScript storage after login.
- The browser session covers chat, streaming, uploads, inline images, downloads, and Markdown export.
- Bearer-token compatibility remains available for controlled automation.
- Cross-origin mutation protection, route-class rate limits, and browser security headers.
- Online SQLite backup plus artifact checksum manifest.
- Pre-deployment backup verification before staging replacement.
- Retained backup policy and confirmation-gated restore with rescue rollback.

### Runtime and automation

- Unified Web/API production container.
- Embedded Git SHA, build time, package version, and environment identity.
- Authenticated System Status panel backed by sanitized `/api/ops/status` data.
- GitHub-hosted CI for typecheck, collaboration/API/adapter/security/preflight/backup tests, browser regression, builds, and exact-container smoke tests.
- Real Chromium regression at 1280×900 desktop and 390×844 mobile sizes.
- Browser regression for direct agents, multi-agent mentions, source-output preservation, participant panels, authentication, export, and logout.
- Isolated localhost staging Compose service.
- Repository-scoped self-hosted runner bootstrap with verified Docker access.
- Non-mutating staging readiness workflow.
- Strict staging deployment with exact-runtime preflight, verified backup, authenticated status, SHA validation, evidence retention, and automatic rollback.

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
npm run preflight
npx playwright install chromium
npm run test:e2e
npm run test:e2e:auth
```

Container preview:

```bash
docker build \
  --build-arg CHAT_BUILD_SHA=local \
  --build-arg CHAT_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg CHAT_VERSION=0.7.0 \
  -t chat-ailucy-v2:local .
docker run --rm -p 127.0.0.1:4174:4174 -v chat-v2-data:/data chat-ailucy-v2:local
```

Backup inside a built container:

```bash
node dist-server/backup.js create
node dist-server/backup.js verify /data/backups/<backup-id>
```

## Documentation

- [`docs/PRODUCT_SPEC_V2.md`](docs/PRODUCT_SPEC_V2.md)
- [`docs/GS7_SCOPE.md`](docs/GS7_SCOPE.md)
- [`docs/BACKEND_ADAPTERS.md`](docs/BACKEND_ADAPTERS.md)
- [`docs/BROWSER_AUTH_AND_STATUS.md`](docs/BROWSER_AUTH_AND_STATUS.md)
- [`docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md`](docs/GITHUB_ACTIONS_AND_DEPLOYMENT.md)
- [`docs/HOME_SERVER_STAGING_SETUP.md`](docs/HOME_SERVER_STAGING_SETUP.md)
- [`docs/SECURITY_AND_RECOVERY.md`](docs/SECURITY_AND_RECOVERY.md)
- [`config/adapters.env.example`](config/adapters.env.example)
