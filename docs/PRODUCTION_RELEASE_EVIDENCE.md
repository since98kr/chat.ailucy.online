# Production release evidence acceptance

## Purpose

A successful production workflow status is necessary but not sufficient to close Issue #55. The release artifact must also pass:

```text
scripts/ops/verify-production-release-evidence.sh
```

The verifier is offline and processes a downloaded ZIP. It does not call GitHub, access a runner or host, or modify production.

## Two immutable identities

The production workflow records two independent commits:

- application candidate: the exact `revision` input, currently frozen at `9a787035ec65e6e9973222b99cb427c64d108f4b`;
- workflow tooling: `github.workflow_sha`, containing the reviewed release workflow and helper scripts.

Both commits must be contained in `main` history. The candidate is checked out as the application source. Rollback and E2E marker helpers are extracted with `git show` from the exact workflow tooling SHA. A moving branch is never executed as release-control code.

## Rollback prerequisite modes

### Standard mode

Default Environment configuration:

```text
CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE=false
CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA=
```

Before candidate build or replacement, the workflow requires:

- `/opt/chat-v2/production/state/current-image`;
- a prior image in the `chat-ailucy-v2:*` namespace;
- that prior image to exist in Docker;
- a readable production SQLite database;
- production roots separate from staging.

The workflow writes `rollback-prerequisites.json`. The deploy controller must then create and verify a backup. The final deployment record must reference the same previous image and backup ID.

### Initial mode

Initial mode is an exceptional empty-state release, not the default:

```text
CHAT_PRODUCTION_ALLOW_INITIAL_RELEASE=true
CHAT_PRODUCTION_INITIAL_RELEASE_APPROVED_SHA=<exact frozen candidate SHA>
```

It is accepted only when all are true:

- no prior image is recorded;
- no production database exists;
- no current revision exists;
- no prior deployment record exists;
- no prior backup verification exists;
- no prior health or operations state exists.

Initial mode records no previous image and no backup ID. The release evidence explicitly reports `releaseMode: initial`. The override must be disabled immediately after the run.

If a prior production service or data set exists, initial mode is prohibited.

## E2E success markers

Markers are created only after the corresponding commands return success.

`local-e2e.json` records:

- exact candidate SHA;
- workflow run ID;
- localhost production endpoint;
- real transport check;
- browser check;
- artifact round trip;
- multimodal check;
- generated-artifact check.

`public-e2e.json` records:

- exact candidate SHA;
- same workflow run ID;
- HTTPS production origin;
- Cloudflare Access check;
- browser check;
- artifact round trip;
- multimodal check;
- generated-artifact check.

The files contain no service credential, access token, API key, database row, or artifact content.

## Artifact verification

Download `chat-v2-production-deploy-<run-id>.zip`, then run:

```bash
bash scripts/ops/verify-production-release-evidence.sh \
  /secure/path/chat-v2-production-deploy-<run-id>.zip \
  9a787035ec65e6e9973222b99cb427c64d108f4b \
  <run-id>
```

To create a new summary file:

```bash
bash scripts/ops/verify-production-release-evidence.sh \
  /secure/path/chat-v2-production-deploy-<run-id>.zip \
  9a787035ec65e6e9973222b99cb427c64d108f4b \
  <run-id> \
  /secure/path/production-release-verification.json
```

The output path must not already exist.

## Required evidence consistency

The verifier checks:

- safe ZIP paths and no extracted symlinks;
- successful strict preflight;
- exact application SHA and production image identity;
- production-only data root and non-staging port;
- all required preflight checks;
- real HTTP Letta and Hermes health;
- rollback prerequisite mode;
- verified backup and checksum in standard mode;
- explicit empty-state evidence in initial mode;
- deployment previous image and backup ID consistency;
- authenticated operations status with exact SHA;
- local and public E2E markers with the same run ID;
- required E2E check names;
- HTTPS public endpoint;
- event order:

```text
rollback prerequisite
  ≤ strict preflight readiness
  ≤ health and authenticated operations
  ≤ deployment record
  ≤ local E2E
  ≤ public E2E
```

Any mismatch fails verification.

## Machine-readable result

A successful summary includes:

- `ok: true` and `mode: deploy`;
- standard or initial release mode;
- exact revision and run ID;
- production image;
- previous image and backup ID;
- deployment timestamp;
- local and public endpoints and timestamps;
- Letta and Hermes status;
- available Playwright report counts.

## Issue #55 closure rule

Issue #55 can close only after all are attached or referenced:

1. approved production Environment and dedicated runner evidence;
2. successful preflight-only workflow and verified preflight artifact;
3. explicit final deployment approval;
4. successful deploy workflow for the same frozen candidate;
5. successful production release evidence summary;
6. release switch returned to `false`;
7. initial-release override returned to `false`, when applicable;
8. production health and public Cloudflare validation confirmed.

A green workflow without a passing offline evidence summary is not an accepted release.