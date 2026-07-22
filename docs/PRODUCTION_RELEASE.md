# Chat V2 production release

## Status

The repository contains a guarded production release framework. It does not deploy automatically when `main` changes.

Current validated release candidate:

- main merge commit: `bd6ce5515eefc1e0be5d40c3a57006781d0d56c3`
- validated integration tree: `5ce49ef00a1cb9ee7378ad447b5e856c7a839aa4`
- V2 CI: run `29937009074`
- isolated/public staging: run `29937336698`
- staging evidence: `chat-v2-cloudflare-access-29937336698`

A future production release must use a full immutable SHA that is contained in `main` history. A branch name such as `main`, an unmerged branch SHA, or a moving tag is not accepted as the release identity.

## Isolation requirements

Production must have resources separate from staging:

- runner label: `chat-production`
- GitHub Environment: `production`
- Compose project: `chat-v2-production`
- container name: `chat-v2-production`
- root: `/opt/chat-v2/production`
- data: `/opt/chat-v2/production/data`
- state: `/opt/chat-v2/production/state`
- production-specific Cloudflare service identity
- production-specific secrets and variables

The scripts reject production roots or data directories under `/opt/chat-v2/staging`.

## Workflow behavior

`.github/workflows/production-release.yml` is `workflow_dispatch` only. It has no `push` trigger.

Inputs:

- `revision`: required full 40-character Git SHA
- `mode`: `preflight` or `deploy`; default is `preflight`
- `confirm`: required for deployment and must exactly equal `DEPLOY_CHAT_V2_PRODUCTION`

The job uses the `production` Environment and runner labels:

```text
self-hosted, linux, x64, chat-production
```

Deployment mode additionally requires production Environment variables:

```text
CHAT_PRODUCTION_RELEASE_ENABLED=true
CHAT_PRODUCTION_APPROVED_SHA=<the exact approved 40-character main SHA>
```

The workflow input, `main` ancestry check, Environment-approved SHA, Environment kill switch, required reviewers, exact checkout, and typed confirmation are independent gates.

## Production Environment configuration

Required path and process variables:

```text
CHAT_PRODUCTION_ROOT=/opt/chat-v2/production
CHAT_PRODUCTION_DATA_DIR=/opt/chat-v2/production/data
CHAT_PRODUCTION_PORT=<production-localhost-port>
CHAT_PRODUCTION_CONTAINER_NAME=chat-v2-production
CHAT_PRODUCTION_COMPOSE_PROJECT=chat-v2-production
CHAT_PRODUCTION_APPROVED_SHA=<approved main SHA>
CHAT_PRODUCTION_RELEASE_ENABLED=false
```

Keep `CHAT_PRODUCTION_RELEASE_ENABLED=false` until the production runner, paths, backups, Cloudflare identity, approved SHA, and operator approval are complete. Change `CHAT_PRODUCTION_APPROVED_SHA` only as part of a reviewed release decision.

Configure production-specific application, rate-limit, upload, Letta, Hermes, authentication, Cloudflare issuer/audience, and external QA variables. Configure secrets only in the `production` Environment. Never copy production values from logs into issues or chat.

Staging Cloudflare client credentials must not be reused in production.

## Preflight mode

Preflight mode:

1. validates the full immutable SHA;
2. checks that the SHA is contained in `main` history;
3. checks out that exact SHA;
4. builds a revision-tagged candidate image;
5. rejects staging paths;
6. validates the production port and container identity;
7. requires strict authentication and real Letta/Hermes adapters;
8. validates the image-embedded SHA;
9. validates disk, directory ownership, and SQLite integrity;
10. writes readiness evidence under the production state root;
11. exits without replacing or restarting the production service.

Run preflight first. A successful preflight is necessary but does not authorize deployment.

## Deployment mode

Deployment mode runs only after all gates pass. The controller:

1. verifies the Environment-approved SHA equals the requested SHA;
2. repeats the exact-image strict preflight;
3. creates and verifies an online SQLite/artifact backup when production data exists;
4. records the previous image as the rollback target;
5. replaces only the `chat-v2-production` Compose project;
6. connects only the configured adapter network;
7. verifies health and the running SHA;
8. verifies authenticated operations status;
9. runs local browser and AI artifact checks;
10. runs public Cloudflare E2E;
11. uploads production evidence.

Any failure after replacement invokes project-scoped rollback. The script never runs an unscoped Docker Compose shutdown.

## Required evidence

A production release is not complete unless the workflow artifact contains:

- requested, approved, and running SHA;
- strict preflight report;
- backup creation and verification results;
- prior rollback image;
- health response;
- authenticated operations status;
- local browser evidence;
- public Cloudflare browser evidence;
- Letta PDF marker result;
- Gemma PNG marker result;
- Hermes generated-file result;
- upload, reload, and byte-identical download results.

## Operator sequence

1. Install and register the dedicated production runner.
2. Create the GitHub `production` Environment with required reviewers.
3. Configure production variables and secrets with release disabled.
4. Set `CHAT_PRODUCTION_APPROVED_SHA` to the reviewed full SHA from `main`.
5. Run the workflow in `preflight` mode for that same SHA.
6. Inspect the evidence and verify that no production replacement occurred.
7. Enable `CHAT_PRODUCTION_RELEASE_ENABLED` only for the approved release window.
8. Run `deploy` with the same SHA and exact typed confirmation.
9. Review all local and external evidence.
10. Disable the release switch after the run.
11. Close the production release issue only after complete evidence is attached.

## Prohibited actions

- automatic deployment from `main` push;
- production execution from the staging runner;
- staging and production sharing a data root;
- staging service credentials in production;
- mutable branch names or unmerged SHAs as release identities;
- workflow input silently overriding the Environment-approved SHA;
- deployment without verified backup and rollback image;
- printing secret state files;
- global Docker Compose shutdown;
- claiming success when required external or multimodal checks were skipped.
