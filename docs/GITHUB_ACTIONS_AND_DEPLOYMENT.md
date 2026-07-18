# GitHub Actions and Deployment Plan

## What GitHub Actions does

GitHub Actions is an automation runner attached to this repository. A workflow can start automatically when code is pushed or a pull request is opened.

The initial `V2 CI` workflow performs verification only:

1. Checks out the exact commit.
2. Installs Node.js dependencies.
3. Runs TypeScript validation.
4. Builds the web application.
5. Stores the built `dist` directory as a temporary workflow artifact.

It does **not** deploy to the home server yet.

## Why this is useful

- The result does not depend on a developer's laptop.
- Every branch and pull request is checked consistently.
- ChatGPT or another connected agent can inspect failed workflow steps and logs.
- Broken code can be stopped before merge or deployment.
- The same automation layer can later deploy without requiring Tei to copy commands manually.

## Long-term deployment architecture

Recommended path:

```text
GitHub branch / pull request
          ↓
GitHub-hosted CI runner
  typecheck + build + tests
          ↓
Tei deployment approval gate
          ↓
Home-server self-hosted runner
  fetch approved release artifact
  deploy to a versioned release directory
  health check
  atomically switch current symlink
  rollback on failure
```

A **self-hosted runner** is a small GitHub Actions service installed on the home server. It receives only jobs allowed by repository workflow and runner labels. This provides an auditable deployment channel without exposing general SSH credentials to the web application.

## Deployment safety requirements

- Deployment runs only after explicit approval.
- Production secrets stay in GitHub Environment secrets or on the home server, never in the repository.
- The runner uses a dedicated low-privilege Linux account.
- The deployment workflow cannot access unrelated home-server services.
- Every deployment uses a versioned release directory.
- A failed health check restores the previous release.
- Database migrations require backups and separate approval when destructive.
- Letta and Hermes adapters are validated independently before production routing changes.

## Planned environments

- `preview`: branch-specific UI preview; mock adapters allowed.
- `staging`: home-server staging service with real adapter connectivity but isolated data.
- `production`: `chat.ailucy.online`.

## Current status

Only CI verification is enabled. Deployment workflow, self-hosted runner registration, Cloudflare routing, production secrets, and rollback scripts will be implemented after the UI prototype and Chat Core are accepted.
