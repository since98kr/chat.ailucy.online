# Security and Recovery

## Single-user security model

`chat.ailucy.online` is a private single-user service. The application supports three runtime authentication modes:

- `disabled`: localhost development and isolated staging only.
- `cloudflare`: accepts only identities supplied by Cloudflare Access through `Cf-Access-Authenticated-User-Email`.
- `token`: requires `Authorization: Bearer <CHAT_ACCESS_TOKEN>` for private API routes.

`/api/health` remains unauthenticated so Docker and GitHub Actions can perform local health checks. All other `/api` routes are subject to the configured authentication and rate limits.

### Cloudflare requirements

For production:

1. Bind the container only to localhost.
2. Expose it exclusively through the existing Cloudflare Tunnel.
3. Apply a Cloudflare Access policy to `chat.ailucy.online`.
4. Set `CHAT_AUTH_MODE=cloudflare`.
5. Set `CHAT_ALLOWED_EMAILS` to the exact approved account address.
6. Set `CHAT_PUBLIC_ORIGIN` and `CHAT_ALLOWED_ORIGIN` to `https://chat.ailucy.online`.

The application trusts the Cloudflare identity header only when the origin is not directly reachable from the public internet. Do not publish the container port directly.

### Runtime protections

- Constant-time bearer-token comparison.
- Cross-origin mutation rejection when an allowed origin is configured.
- Separate request limits for general API traffic, chat generation, and uploads.
- Content Security Policy, frame denial, MIME sniffing denial, referrer restriction, and browser permission restriction.
- Backend secrets remain server-side and are supplied only through GitHub Environment secrets or host environment variables.

## Backup format

A backup is stored under `/data/backups/<timestamp>/` and contains:

```text
manifest.json
chat-v2.sqlite
artifacts/
```

The manifest records:

- SQLite SHA-256 and byte size.
- Every artifact SHA-256 and byte size.
- Artifact count and total bytes.
- Backup creation time and format version.

The backup engine uses SQLite's online backup API, so the database can remain active while a consistent backup is created. Every deployment verifies the SQLite integrity check and all recorded hashes before replacing the current staging container.

Default retention is 10 verified backups and can be changed with `CHAT_BACKUP_RETENTION`.

## Deployment behavior

The staging deployment sequence is:

1. Build a revision-tagged image.
2. If an existing database is present, create an online database and artifact backup.
3. Verify the backup.
4. Start the new image using the data directory owner's UID/GID.
5. Verify application health.
6. Record the new current image and revision.
7. On failure, restart the prior image.

A backup failure stops deployment before the running service is replaced.

## Restore behavior

Restore is intentionally not exposed as an automatic GitHub workflow. It is destructive and requires an exact confirmation value.

```bash
sudo -u chat-runner \
  CONFIRM_RESTORE=<backup-id> \
  bash scripts/backup/restore-staging.sh <backup-id>
```

The restore script:

1. Verifies the selected backup.
2. Stops staging.
3. Copies the current database and artifacts into `/data/recovery/pre-restore-*`.
4. Restores the selected backup.
5. Starts staging and performs a health check.
6. Automatically restores the pre-restore data if the health check fails.

Production restore must remain a separately approved operation even after production automation is introduced.
