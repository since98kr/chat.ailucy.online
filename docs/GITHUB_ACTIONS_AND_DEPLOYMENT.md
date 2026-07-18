# GitHub Actions and deployment

## Implemented automation

### V2 CI

Every pull request and push to `main` or `agent/**` runs on a GitHub-hosted runner:

1. Install dependencies.
2. Validate deployment, preflight, runner, backup, and restore scripts.
3. Strict TypeScript validation.
4. API, adapter, security, preflight, backup, and operations tests.
5. Web and API production builds.
6. Real Chromium regression at desktop and smartphone sizes.
7. Versioned production-container build.
8. Exact-image preflight.
9. Runtime security, build identity, online backup, and recovery smoke tests.
10. Diagnostic artifact publication.

### Staging preflight

`.github/workflows/staging-preflight.yml` runs only on the repository-scoped runner with labels:

```text
self-hosted, linux, x64, chat-staging
```

It builds the requested Git revision and runs the same container that would be deployed, without replacing the running service. Strict mode verifies:

- Docker/Compose availability and runner permissions
- Staging data-directory ownership
- Local port conflicts
- Minimum disk capacity
- SQLite integrity
- Non-disabled authentication
- Configured public origin
- Healthy real HTTP Letta adapter
- Healthy real HTTP Hermes adapter
- Embedded image revision

The report is written under `/opt/chat-v2/staging/state` and uploaded to the workflow run.

### Staging deployment

`.github/workflows/deploy-staging.yml` checks out an explicit ref and calls `scripts/deploy/staging.sh`.

The service:

- Binds to `127.0.0.1:14174` only.
- Uses `/opt/chat-v2/staging/data`, separate from production.
- Builds a revision-tagged image with embedded Git SHA, build time, and package version.
- Runs strict preflight before replacement.
- Creates and verifies an online SQLite/artifact backup when prior data exists.
- Keeps the previous image as a rollback target.
- Performs public health and authenticated operations-status checks.
- Confirms that the running SHA equals the requested revision.
- Automatically restores the previous image if any gate fails.
- Uploads preflight, backup, health, operations, and deployment evidence.

## One-time self-hosted runner bootstrap

Use `scripts/runner/install-chat-staging-runner.sh` on the home server. The script requires:

- `GITHUB_REPOSITORY_URL`
- A short-lived `GITHUB_RUNNER_TOKEN`
- An explicitly approved `RUNNER_VERSION`
- The official `RUNNER_SHA256`

It creates the dedicated `chat-runner` account, grants only the Docker access required for this repository runner, aligns staging data ownership, verifies Docker access, and installs the runner as a service under `/opt/actions-runner-chat-staging`.

The registration token and checksum are intentionally absent from source control. Host root access is required once; it cannot be performed by the GitHub connector alone.

Complete instructions: [`HOME_SERVER_STAGING_SETUP.md`](HOME_SERVER_STAGING_SETUP.md).

## GitHub `staging` Environment

The complete variable and secret list is maintained in:

- [`HOME_SERVER_STAGING_SETUP.md`](HOME_SERVER_STAGING_SETUP.md)
- [`../config/adapters.env.example`](../config/adapters.env.example)

Strict staging does not permit mock fallback. A configured backend that fails its health probe is reported unhealthy, and deployment stops before replacement.

## Traceability

Every accepted staging release produces evidence for:

- Requested and running Git SHA
- Package version and build time
- Authentication mode, without secret values
- Letta and Hermes health/mode/latency
- Pre-deployment backup ID and verification
- Health response
- Authenticated operations response
- Prior rollback image
- Deployment timestamp

## Safety model

```text
GitHub branch / pull request
          ↓
GitHub-hosted CI
  tests + browser regression + exact-image smoke
          ↓
main integration
          ↓
Staging preflight (no replacement)
          ↓
Manual staging workflow
          ↓
Dedicated home-server runner
  strict preflight
  verified backup
  isolated replacement
  health + authenticated status + SHA validation
  automatic rollback
```

Production remains separate. These workflows do not modify a production container, production database, Cloudflare route, Letta service, or Hermes service.

Production deployment will require:

- A separate runner label and Compose project.
- Production-specific data and backup roots.
- External URL validation through Cloudflare Access.
- An explicit GitHub `production` Environment gate.
- Verified rollback against the previous production image.

## Why this architecture is useful

- Development no longer depends on repeatedly copying deployment commands.
- A staging revision cannot be accepted unless its exact SHA is running.
- Missing authentication or mock adapters stop strict staging deployment.
- Data is backed up and verified before replacement.
- Broken releases roll back automatically.
- Backend credentials remain outside source control.
- The Chat application does not receive broad SSH access to unrelated services.
