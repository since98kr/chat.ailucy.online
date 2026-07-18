# GitHub Actions and deployment

## What is implemented

### V2 CI

Every pull request and push to `main` or `agent/**` runs on a GitHub-hosted runner:

1. Install dependencies.
2. Strict TypeScript validation.
3. API integration tests.
4. Web and API production builds.
5. Production Docker image build.
6. Running-container smoke tests for Web UI and API health.
7. Temporary publication of Web and API build artifacts.

### Staging deployment

`.github/workflows/deploy-staging.yml` is a manual deployment workflow targeting only a self-hosted runner with all of these labels:

```text
self-hosted, linux, x64, chat-staging
```

The workflow does not run on a generic server runner. It checks out an explicit ref and executes `scripts/deploy/staging.sh`.

The staging service:

- Binds to `127.0.0.1:14174` only.
- Uses `/opt/chat-v2/staging/data`, separate from production.
- Builds a revision-tagged Docker image.
- Keeps the previous image as a rollback target.
- Runs application health checks after replacement.
- Automatically restores the previous image if health validation fails.
- Writes the deployed revision and last health response under `/opt/chat-v2/staging/state`.

## One-time self-hosted runner bootstrap

Use `scripts/runner/install-chat-staging-runner.sh` on the home server. The script requires:

- `GITHUB_REPOSITORY_URL`
- A short-lived `GITHUB_RUNNER_TOKEN`
- An explicitly approved `RUNNER_VERSION`
- The official `RUNNER_SHA256`

It creates a dedicated `chat-runner` service account and a repository-scoped runner under `/opt/actions-runner-chat-staging`.

The registration token and checksum are intentionally not stored in this repository. Runner installation is a one-time home-server action and cannot be completed from the GitHub connector alone because it requires host root access.

## Environment configuration

Create a GitHub Environment named `staging`.

Variables:

- `CHAT_ALLOWED_ORIGIN`
- `LETTA_BASE_URL`
- `LETTA_CHAT_PATH`
- `LETTA_HEALTH_PATH`
- `LETTA_AGENT_ID`
- `HERMES_BASE_URL`
- `HERMES_CHAT_PATH`
- `HERMES_HEALTH_PATH`
- `HERMES_AGENT_ID`

Secrets:

- `LETTA_API_KEY`
- `HERMES_API_KEY`

Empty backend URLs keep the corresponding system in deterministic mock mode. A configured backend that fails its health probe is reported unhealthy; it does not silently fall back to mock mode.

## Safety model

```text
GitHub branch / pull request
          ↓
GitHub-hosted CI
  typecheck + tests + build + container smoke
          ↓
main integration
          ↓
manual staging workflow
          ↓
home-server chat-staging runner
  revision image build
  isolated container replacement
  health validation
  automatic rollback on failure
```

Production remains separate from staging. The current workflow does not modify the production container, production database, Cloudflare route, Letta service, or Hermes service.

Production deployment will require:

- A separate runner label and Compose project.
- Backup of SQLite and artifacts before migration.
- Production-specific health and external URL checks.
- An explicit production environment gate.
- Verified rollback against the previous production image.

## Why this architecture is useful

- Development no longer depends on Tei manually copying deployment commands.
- Every deployed revision is traceable to a Git commit.
- A broken container is rejected before staging replacement.
- A runtime failure after replacement triggers rollback.
- Backend credentials remain outside source control.
- The Chat application does not need broad SSH credentials or access to unrelated services.
