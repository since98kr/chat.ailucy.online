# Production preflight evidence verification

## Purpose

`scripts/ops/verify-production-preflight-evidence.sh` verifies a downloaded `chat-v2-production-preflight-<run-id>` artifact before any production deployment decision.

The verifier processes a local ZIP only. It does not call GitHub, access a runner or host, read the production database, restart a service, or modify Cloudflare.

## Usage

```bash
bash scripts/ops/verify-production-preflight-evidence.sh \
  /secure/path/chat-v2-production-preflight-<run-id>.zip \
  9a787035ec65e6e9973222b99cb427c64d108f4b
```

To write a new summary file atomically:

```bash
bash scripts/ops/verify-production-preflight-evidence.sh \
  /secure/path/chat-v2-production-preflight-<run-id>.zip \
  9a787035ec65e6e9973222b99cb427c64d108f4b \
  /secure/path/production-preflight-verification.json
```

The output path must not already exist.

## ZIP safety checks

Before extraction, the verifier rejects:

- an empty ZIP;
- absolute paths;
- `..` path traversal;
- backslash paths;
- duplicate paths.

After extraction, it rejects symbolic links.

The verifier requires exactly one of each:

- `chat-v2/production/state/last-production-readiness.json`;
- `chat-v2/production/state/last-preflight.json`;
- `chat-v2/production/state/last-preflight-output.log`.

A prior `last-deployment.json` is optional because the production state root may retain historical deployment evidence.

## Readiness checks

`last-production-readiness.json` must contain:

- `ok: true`;
- `mode: preflight`;
- exact frozen revision;
- image `chat-ailucy-v2:production-<exact-sha>`;
- data directory under `/opt/chat-v2/production/`;
- a valid production port from 1024 through 65535;
- a port other than staging `14174`;
- a valid `checkedAt` timestamp.

## Strict preflight checks

`last-preflight.json` must contain:

- `ok: true`;
- `strict: true`;
- exact build SHA;
- build environment `production`;
- unique successful check records;
- database, artifact, backup, disk, SQLite, authentication, public-origin, Letta, and Hermes checks;
- healthy Letta and Hermes adapters;
- real HTTP adapter mode;
- HTTP 200 detail for both adapters.

The preflight output log must contain the exact completion marker for the approved SHA.

## Historical deployment handling

The presence of `last-deployment.json` does not automatically mean the preflight replaced production. It may be historical state from an earlier release.

The verifier compares timestamps:

- `deployment.deployedAt < readiness.checkedAt`: accepted as older historical evidence;
- `deployment.deployedAt >= readiness.checkedAt`: verification fails because replacement occurred at or after the preflight.

This prevents both false alarms from stale state and false approval after an unintended replacement.

## Machine-readable summary

A successful summary includes:

- `ok` and `mode`;
- exact revision and image;
- readiness timestamp;
- production data directory and port;
- strict-check count;
- Letta and Hermes mode/detail;
- prior deployment relationship;
- source evidence filenames.

The summary contains no secret values, access tokens, API keys, database rows, or artifact contents.

## CI fixtures

`scripts/ci/production-preflight-evidence-smoke.sh` creates local synthetic ZIPs and verifies:

- valid preflight with an older historical deployment;
- wrong expected SHA rejection;
- deployment at or after readiness rejection;
- unhealthy Hermes rejection;
- ZIP traversal rejection;
- missing preflight log rejection.

The CI does not contact GitHub, Letta, Hermes, Cloudflare, a runner, or a production host.

## Release boundary

A successful evidence verification confirms only that the preflight artifact is internally consistent and indicates no replacement during that preflight. It does not authorize deploy mode.

Deployment still requires the explicit final production release gate in Issue #55.