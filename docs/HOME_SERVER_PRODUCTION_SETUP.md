# Home-server production: one-time control-plane setup

## Boundary

This setup prepares the dedicated production runner and GitHub `production` Environment. It does not deploy Chat V2, restart a production service, migrate or restore data, or change Cloudflare routing or Access policies.

Production remains isolated from staging:

- Linux service account: `chat-production-runner`
- repository runner custom label: `chat-production`
- runner home: `/opt/actions-runner-chat-production`
- production root: `/opt/chat-v2/production`
- data root: `/opt/chat-v2/production/data`
- state root: `/opt/chat-v2/production/state`
- production-only local port
- production-only Cloudflare service identity

The installer refuses the staging runner identity and `/opt/chat-v2/staging` paths.

## 1. Review the production release candidate

The approved revision must be a full 40-character SHA contained in `main` history. Record it in Issue #55 and in the production Environment variable `CHAT_PRODUCTION_APPROVED_SHA`.

Do not use a branch name, abbreviated SHA, unmerged branch SHA, or moving tag.

## 2. Create the GitHub `production` Environment

Create a repository Environment named `production` and configure required reviewers. Keep the release switch disabled while preparing the runner and variables.

### Release-control variables

| Variable | Initial value | Purpose |
|---|---:|---|
| `CHAT_PRODUCTION_RELEASE_ENABLED` | `false` | Independent deployment kill switch |
| `CHAT_PRODUCTION_APPROVED_SHA` | reviewed full SHA | Must equal the workflow input for deploy mode |
| `CHAT_PRODUCTION_ROOT` | `/opt/chat-v2/production` | Production application root |
| `CHAT_PRODUCTION_DATA_DIR` | `/opt/chat-v2/production/data` | Database, artifact, and backup root |
| `CHAT_PRODUCTION_PORT` | production-specific localhost port | Must not collide with staging or another service |
| `CHAT_PRODUCTION_CONTAINER_NAME` | `chat-v2-production` | Dedicated container identity |
| `CHAT_PRODUCTION_COMPOSE_PROJECT` | `chat-v2-production` | Project-scoped replacement and rollback |

### Core application variables

- `CHAT_PUBLIC_ORIGIN`
- `CHAT_ALLOWED_ORIGIN`
- `CHAT_AUTH_MODE` — production must use `cloudflare` or `token`
- `CHAT_ALLOWED_EMAILS`
- `CHAT_ALLOWED_SERVICE_CLIENT_IDS`
- `CHAT_CF_ACCESS_ISSUER`
- `CHAT_CF_ACCESS_AUD`
- `CHAT_PREFLIGHT_MIN_FREE_BYTES`
- `CHAT_BACKUP_RETENTION`
- `CHAT_RATE_LIMIT_GENERAL`
- `CHAT_RATE_LIMIT_CHAT`
- `CHAT_RATE_LIMIT_UPLOAD`
- `CHAT_MAX_UPLOAD_BYTES`
- `CHAT_MAX_GENERATED_ARTIFACT_BYTES`
- `CHAT_MAX_INLINE_GENERATED_ARTIFACT_PAYLOAD_BYTES`
- `CHAT_MAX_EXTRACTED_TEXT_CHARACTERS`
- `CHAT_MAX_PDF_PAGES`

### Letta variables

- `LETTA_BASE_URL`
- `LETTA_CHAT_PATH`
- `LETTA_HEALTH_PATH`
- `LETTA_AGENT_ID`
- `LETTA_TIMEOUT_MS`
- `LETTA_PROTOCOL`
- `LETTA_MODEL_MAP_JSON`
- `LETTA_MAX_ARTIFACT_BYTES`
- `LETTA_MAX_ARTIFACT_TOTAL_BYTES`
- `LETTA_MAX_TEXT_ARTIFACT_BYTES`
- `LETTA_NATIVE_BINARY_ARTIFACTS`
- `LETTA_ARTIFACT_TOOL_ENABLED`

### Hermes variables

- `HERMES_BASE_URL`
- `HERMES_CHAT_PATH`
- `HERMES_HEALTH_PATH`
- `HERMES_AGENT_ID`
- `HERMES_TIMEOUT_MS`
- `HERMES_PROTOCOL`
- `HERMES_MODEL_MAP_JSON`
- `HERMES_MAX_ARTIFACT_BYTES`
- `HERMES_MAX_ARTIFACT_TOTAL_BYTES`
- `HERMES_ARTIFACT_TOOL_ENABLED`
- `HERMES_ARTIFACT_ENVELOPE_ENABLED`
- `HERMES_DOCKER_NETWORK`
- `CHAT_HERMES_VISION_AGENT_ID`

Strict production preflight fails when authentication is disabled or either real adapter is missing or unhealthy.

### Public Cloudflare QA variables

- `CF_ACCESS_CLIENT_ID` — production-only service-token client ID

Do not reuse the staging client ID. The production Access application and origin allowlist must recognize the production service identity.

### Secrets

- `LETTA_API_KEY`, when required
- `HERMES_API_KEY`, when required
- `CHAT_ACCESS_TOKEN`, only for token authentication
- `CF_ACCESS_CLIENT_SECRET`, for the production-only service identity

Never paste secret values into issues, commits, workflow summaries, terminal history, or chat.

## 3. Validate runner installation inputs without mutation

From a trusted checkout, run validation-only mode first. It does not require a registration token or root privileges and does not create directories, users, services, or GitHub registrations.

```bash
RUNNER_VALIDATE_ONLY=true \
GITHUB_REPOSITORY_URL='https://github.com/since98kr/chat.ailucy.online' \
RUNNER_VERSION='<PINNED_VERSION>' \
RUNNER_SHA256='<OFFICIAL_64_HEX_SHA256>' \
RUNNER_NAME='agentlucy-chat-production' \
bash scripts/runner/install-chat-production-runner.sh
```

The validation must report the dedicated repository, runner identity, runner home, production root, data root, and state root.

## 4. Install the dedicated production runner once

Obtain a short-lived repository runner registration token from Repository Settings → Actions → Runners. Select a pinned GitHub Actions runner release and copy its official Linux x64 archive SHA-256.

Run only from a trusted checkout:

```bash
sudo env \
  GITHUB_REPOSITORY_URL='https://github.com/since98kr/chat.ailucy.online' \
  GITHUB_RUNNER_TOKEN='<SHORT_LIVED_REGISTRATION_TOKEN>' \
  RUNNER_VERSION='<PINNED_VERSION>' \
  RUNNER_SHA256='<OFFICIAL_64_HEX_SHA256>' \
  RUNNER_NAME='agentlucy-chat-production' \
  bash scripts/runner/install-chat-production-runner.sh
```

The installer:

1. verifies the repository URL, pinned version, and archive checksum format;
2. refuses staging user, runner name, runner home, root, data, and state paths;
3. refuses a non-empty or already registered runner directory;
4. creates a dedicated non-login service account when absent;
5. prepares missing production directories without deleting, migrating, recursively changing ownership, or overwriting existing files;
6. verifies that the runner account can access Docker and the production data/state directories;
7. downloads the official archive over HTTPS and verifies the exact SHA-256;
8. verifies the extracted runner version;
9. registers only the `chat-production` custom label;
10. installs and starts the repository runner service.

If an existing production root is not accessible by the dedicated account, the installer fails instead of changing existing ownership recursively. Inspect and remediate the host deliberately.

## 5. Verify GitHub runner identity

In Repository Settings → Actions → Runners, verify:

- name: `agentlucy-chat-production`
- status: `Idle`
- OS/architecture: Linux x64
- labels include: `self-hosted`, `linux`, `x64`, `chat-production`
- labels do not include: `chat-staging`

Do not add the runner to another repository or organization-wide runner group.

## 6. Run preflight only

Keep:

```text
CHAT_PRODUCTION_RELEASE_ENABLED=false
```

Run **Production release gate** with:

- `revision`: the exact approved SHA
- `mode`: `preflight`
- `confirm`: empty

Preflight builds and validates the candidate and may create the configured production root/state evidence, but it does not replace or restart the production Compose project.

Review:

- requested SHA is contained in `main`;
- image-embedded SHA matches;
- production paths do not use staging roots;
- production port is safe;
- SQLite integrity passes when data exists;
- authentication is strict;
- Letta and Hermes are healthy;
- no replacement occurred;
- the evidence artifact contains readiness and preflight reports.

A successful preflight does not authorize deployment.

## 7. Deployment remains a critical gate

Before deploy mode:

1. review preflight evidence;
2. confirm the production backup and rollback strategy;
3. confirm the production Cloudflare service identity and hostname;
4. confirm the exact Environment-approved SHA;
5. obtain explicit production release approval;
6. temporarily set `CHAT_PRODUCTION_RELEASE_ENABLED=true`;
7. run deploy mode with the exact typed confirmation;
8. disable the release switch after completion.

Production deployment, database replacement, service restart, secret changes, and Cloudflare policy changes remain explicit high-impact approval gates.

## Prohibited actions

- using the staging runner for production;
- sharing runner home, data root, state root, port, container name, or Compose project with staging;
- registering the runner with an unpinned archive or unverified checksum;
- using a long-lived runner registration token;
- printing tokens or secrets;
- running the production workflow before required reviewers and variables are configured;
- enabling release while testing runner setup;
- deleting or migrating production data during bootstrap;
- global Docker Compose shutdown.
