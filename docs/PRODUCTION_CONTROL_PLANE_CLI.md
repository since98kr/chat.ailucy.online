# Chat V2 production control-plane CLI

## Purpose

`scripts/ops/production-control-plane.sh` prepares and validates the GitHub-side production control plane for Issue #55. It does not SSH to the production host, register a runner, restart a service, modify production data, or change Cloudflare.

The frozen production candidate remains:

```text
9a787035ec65e6e9973222b99cb427c64d108f4b
```

The controller is repository-bound to `since98kr/chat.ailucy.online`, the GitHub Environment `production`, workflow `production-release.yml`, runner label `chat-production`, and runner name `agentlucy-chat-production` by default.

## Safety model

The CLI has three actions:

- `inspect`: read-only validation of GitHub Environment protection, approved SHA, release switch, dedicated runner, workflow, and `main` ancestry;
- `configure`: validates production variables and secret names, but defaults to dry-run;
- `dispatch-preflight`: runs `inspect`, then defaults to a dry-run workflow preview.

`configure` and `dispatch-preflight` mutate GitHub only when:

```text
PRODUCTION_CONTROL_APPLY=true
```

The CLI never enables `CHAT_PRODUCTION_RELEASE_ENABLED`; configuration always pins it to `false`. It can dispatch only `mode=preflight`, never `mode=deploy`.

Secret values are read from process environment variables and sent through standard input to `gh secret set`. Logs contain secret names only.

## Prerequisites

Use a trusted checkout containing the frozen candidate and production controls. Install and authenticate GitHub CLI with repository administration and Actions permissions:

```bash
gh auth status --hostname github.com
```

The dedicated production runner must be installed separately with:

```text
scripts/runner/install-chat-production-runner.sh
```

See `docs/HOME_SERVER_PRODUCTION_SETUP.md`.

## 1. Prepare a production variable file

Create a local file outside version control. Do not include secrets.

```dotenv
CHAT_PRODUCTION_PORT=<production-localhost-port>
CHAT_PUBLIC_ORIGIN=https://<production-hostname>
CHAT_ALLOWED_ORIGIN=https://<production-hostname>
CHAT_AUTH_MODE=cloudflare
CHAT_ALLOWED_EMAILS=<comma-separated-approved-identities>
CHAT_ALLOWED_SERVICE_CLIENT_IDS=<production-service-client-id>
CHAT_CF_ACCESS_ISSUER=https://<team>.cloudflareaccess.com
CHAT_CF_ACCESS_AUD=<production-access-audience>
CHAT_PREFLIGHT_MIN_FREE_BYTES=2147483648
CHAT_BACKUP_RETENTION=10
CHAT_RATE_LIMIT_GENERAL=300
CHAT_RATE_LIMIT_CHAT=30
CHAT_RATE_LIMIT_UPLOAD=60
CHAT_MAX_UPLOAD_BYTES=52428800
CHAT_MAX_GENERATED_ARTIFACT_BYTES=52428800
CHAT_MAX_INLINE_GENERATED_ARTIFACT_PAYLOAD_BYTES=10485760
CHAT_MAX_EXTRACTED_TEXT_CHARACTERS=2000000
CHAT_MAX_PDF_PAGES=200
LETTA_BASE_URL=<production-reachable-letta-url>
LETTA_CHAT_PATH=/v1/chat/stream
LETTA_HEALTH_PATH=/health
LETTA_AGENT_ID=<production-letta-agent-id>
LETTA_TIMEOUT_MS=10000
LETTA_PROTOCOL=native
HERMES_BASE_URL=<production-reachable-hermes-url>
HERMES_CHAT_PATH=/v1/chat/stream
HERMES_HEALTH_PATH=/health
HERMES_AGENT_ID=<production-hermes-agent-id>
HERMES_TIMEOUT_MS=10000
HERMES_PROTOCOL=native
HERMES_DOCKER_NETWORK=<production-adapter-network>
CHAT_HERMES_VISION_AGENT_ID=<production-vision-agent-id>
CF_ACCESS_CLIENT_ID=<production-only-cloudflare-service-client-id>
```

The controller adds and locks these release-control variables itself:

- `CHAT_PRODUCTION_RELEASE_ENABLED=false`
- `CHAT_PRODUCTION_APPROVED_SHA=9a787035ec65e6e9973222b99cb427c64d108f4b`
- `CHAT_PRODUCTION_ROOT=/opt/chat-v2/production`
- `CHAT_PRODUCTION_DATA_DIR=/opt/chat-v2/production/data`
- `CHAT_PRODUCTION_CONTAINER_NAME=chat-v2-production`
- `CHAT_PRODUCTION_COMPOSE_PROJECT=chat-v2-production`

The variable parser rejects secret-like names such as `*_API_KEY`, `*SECRET*`, and `*TOKEN*`.

## 2. Resolve a required reviewer ID

Use a reviewer who can approve the `production` Environment. For a user:

```bash
gh api users/<reviewer-login> --jq .id
```

For an organization team, use the numeric team ID and set reviewer type to `Team`.

Do not configure a sole reviewer who is blocked by `prevent_self_review=true` when no independent approver exists.

## 3. Dry-run Environment configuration

Provide secret names as a comma-separated list. Their values must exist only in the process environment.

Example:

```bash
export CF_ACCESS_CLIENT_SECRET='<production-secret>'
export LETTA_API_KEY='<production-secret>'
export HERMES_API_KEY='<production-secret>'

PRODUCTION_VARIABLE_FILE=/secure/path/chat-production.env \
PRODUCTION_SECRET_NAMES='CF_ACCESS_CLIENT_SECRET,LETTA_API_KEY,HERMES_API_KEY' \
bash scripts/ops/production-control-plane.sh configure
```

Expected behavior:

- validates all required variables;
- rejects the staging port `14174`;
- rejects staging paths and mutable candidate identifiers;
- validates that every named secret is present;
- prints variable and secret names only;
- changes no GitHub state.

## 4. Apply Environment configuration

After reviewing the dry-run output:

```bash
PRODUCTION_CONTROL_APPLY=true \
PRODUCTION_REVIEWER_TYPE=User \
PRODUCTION_REVIEWER_ID='<numeric-reviewer-id>' \
PRODUCTION_PREVENT_SELF_REVIEW=true \
PRODUCTION_VARIABLE_FILE=/secure/path/chat-production.env \
PRODUCTION_SECRET_NAMES='CF_ACCESS_CLIENT_SECRET,LETTA_API_KEY,HERMES_API_KEY' \
bash scripts/ops/production-control-plane.sh configure
```

This operation:

1. confirms the frozen SHA is contained in `main`;
2. creates or updates the `production` Environment;
3. configures one required reviewer;
4. writes production Environment variables with release disabled;
5. uploads only the named secrets from process memory;
6. does not register a runner or execute a workflow.

Clear secret environment variables from the shell after completion.

## 5. Inspect the complete control plane

```bash
bash scripts/ops/production-control-plane.sh inspect
```

The inspection fails unless all of the following are true:

- `production` Environment exists;
- at least one required reviewer is configured;
- Environment-approved SHA equals the frozen candidate;
- `CHAT_PRODUCTION_RELEASE_ENABLED=false`;
- candidate is contained in `main` history;
- runner `agentlucy-chat-production` is online and idle;
- runner has `chat-production` and does not have `chat-staging`;
- `production-release.yml` is available.

No secret values are read or printed.

## 6. Preview production preflight dispatch

```bash
bash scripts/ops/production-control-plane.sh dispatch-preflight
```

This repeats the complete read-only inspection and prints the exact workflow command without dispatching it.

## 7. Dispatch preflight only

After inspection succeeds:

```bash
PRODUCTION_CONTROL_APPLY=true \
bash scripts/ops/production-control-plane.sh dispatch-preflight
```

The helper dispatches:

- workflow: `production-release.yml`
- ref: `main`
- revision: frozen 40-character candidate SHA
- mode: `preflight`
- confirmation: omitted

It cannot request deploy mode and does not enable the release switch.

## 8. Review evidence

The production workflow should remain in preflight mode and produce readiness evidence without replacing the production Compose project. Verify:

- exact candidate checkout and `main` ancestry;
- production-only root, data, state, port, container, and Compose project;
- strict authentication;
- real Letta and Hermes health;
- embedded image SHA;
- disk and SQLite integrity;
- no production replacement or restart;
- production readiness artifact upload.

A successful preflight does not authorize deploy mode. Deployment remains the final high-impact gate in Issue #55.

## CI coverage

`scripts/ci/production-control-plane-smoke.sh` uses a fake `gh` executable. It verifies:

- read-only inspection success with an online dedicated runner;
- dry-run configuration without secret-value exposure;
- rejection of the staging port;
- rejection of secret-like Environment variable names;
- dry-run dispatch does not call `gh workflow run`;
- apply-mode helper dispatches `mode=preflight` only;
- deploy mode is never requested.

The CI smoke does not contact GitHub, a runner, a production host, Letta, Hermes, or Cloudflare.