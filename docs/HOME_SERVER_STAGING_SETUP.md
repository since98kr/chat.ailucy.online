# Home-server staging: one-time setup

This is the only host-level handoff required before Chat V2 staging can be operated entirely through GitHub Actions.

## Boundary

The setup does not deploy production, change Cloudflare routing, or touch existing Letta/Hermes data. It creates:

- Dedicated Linux account: `chat-runner`
- Dedicated repository runner: label `chat-staging`
- Isolated data root: `/opt/chat-v2/staging/data`
- Isolated state root: `/opt/chat-v2/staging/state`
- Local staging port: `127.0.0.1:14174`

## 1. Configure the GitHub `staging` Environment

Create a repository Environment named `staging`.

### Required variables

| Variable | Purpose |
|---|---|
| `CHAT_PUBLIC_ORIGIN` | Intended staging browser origin |
| `CHAT_ALLOWED_ORIGIN` | Allowed mutation origin; normally the same value |
| `CHAT_AUTH_MODE` | Recommended: `cloudflare` |
| `CHAT_ALLOWED_EMAILS` | Comma-separated Cloudflare Access identities |
| `CHAT_BACKUP_RETENTION` | Recommended: `10` |
| `CHAT_PREFLIGHT_MIN_FREE_BYTES` | Recommended: `2147483648` |
| `CHAT_RATE_LIMIT_GENERAL` | Recommended: `300` |
| `CHAT_RATE_LIMIT_CHAT` | Recommended: `30` |
| `CHAT_RATE_LIMIT_UPLOAD` | Recommended: `60` |
| `LETTA_BASE_URL` | Internal Letta base URL reachable from the home server |
| `LETTA_CHAT_PATH` | Letta streaming chat path |
| `LETTA_HEALTH_PATH` | Letta health path |
| `LETTA_AGENT_ID` | Canonical `[Letta] Lucy` identifier |
| `LETTA_TIMEOUT_MS` | Recommended: `10000` |
| `HERMES_BASE_URL` | Internal Hermes base URL reachable from the home server |
| `HERMES_CHAT_PATH` | Hermes streaming chat path |
| `HERMES_HEALTH_PATH` | Hermes health path |
| `HERMES_AGENT_ID` | Canonical `[Hermes] Lucy` identifier |
| `HERMES_TIMEOUT_MS` | Recommended: `10000` |

### Secrets

- `LETTA_API_KEY`, when Letta requires a bearer key
- `HERMES_API_KEY`, when Hermes requires a bearer key
- `CHAT_ACCESS_TOKEN`, only when `CHAT_AUTH_MODE=token`

Strict staging preflight intentionally fails when authentication is disabled or either real adapter is missing/unhealthy.

## 2. Install the dedicated runner once

Obtain a short-lived repository runner registration token from GitHub repository settings. Choose an explicit GitHub Actions runner release and copy its official SHA-256 checksum.

From a trusted checkout of this repository on the home server:

```bash
sudo env \
  GITHUB_REPOSITORY_URL='https://github.com/since98kr/chat.ailucy.online' \
  GITHUB_RUNNER_TOKEN='<SHORT_LIVED_TOKEN>' \
  RUNNER_VERSION='<PINNED_VERSION>' \
  RUNNER_SHA256='<OFFICIAL_SHA256>' \
  bash scripts/runner/install-chat-staging-runner.sh
```

The registration token is not an application secret and expires quickly. Do not commit it or paste it into a long-lived config file.

## 3. Run readiness diagnosis

In GitHub Actions, run **Staging preflight** against `main` with `strict=true`.

It verifies the exact production container on the home server:

- Docker and Compose access
- Dedicated data directory permissions
- Local port ownership
- Minimum free disk space
- SQLite integrity, when a database exists
- Authentication configuration
- Letta health and HTTP mode
- Hermes health and HTTP mode
- Embedded build SHA

The workflow changes no running container.

## 4. Deploy staging

After preflight passes, run **Deploy staging** against the desired commit or `main`.

Deployment performs:

1. Exact-revision image build with embedded SHA/time/version.
2. Strict preflight again.
3. Verified online backup when prior data exists.
4. Isolated container replacement.
5. Public health check.
6. Authenticated `/api/ops/status` check.
7. Running SHA comparison.
8. Automatic rollback on any failure.
9. Evidence upload to the workflow run.

## 5. Cloudflare exposure remains a separate operation

The service continues to bind only to `127.0.0.1:14174`. A Cloudflare Tunnel ingress and Access application may be connected after staging is healthy. That routing change is deliberately outside automatic staging deployment.

## Recovery

Backups are stored under `/opt/chat-v2/staging/data/backups`. Restoration uses `scripts/backup/restore-staging.sh` and requires the explicit confirmation phrase defined by that script. Restore is a destructive operational action and remains a separate approval gate.
