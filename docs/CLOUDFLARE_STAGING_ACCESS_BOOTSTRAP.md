# Cloudflare Access Bootstrap for Chat V2 Staging

## Current diagnosis

`https://chat-staging.ailucy.online` currently reaches Chat V2 through Cloudflare Tunnel but is not protected by a Cloudflare Access application:

- `/` returns the application shell with HTTP 200;
- `/api/auth/session` returns Chat V2 HTTP 403 because no trusted Cloudflare identity reaches the origin;
- `/cdn-cgi/access/login` returns HTTP 404;
- no usable staging service-token secret is stored on the runner;
- no Cloudflare management API token or account ID is configured in the GitHub `staging` environment.

The old service Client ID alone cannot recover its Client Secret. Cloudflare returns the secret only when a service token is created or rotated.

## One-time external prerequisite

Do not paste any credential into an issue, commit, workflow log, or chat.

In Cloudflare, create an account API token scoped only to the Chat V2 account with:

- `Access: Apps and Policies Write`;
- `Access: Service Tokens Write`;
- `Access: Organizations, Identity Providers, and Groups Read`.

Then open GitHub:

`Repository Settings → Environments → staging`

Add:

- environment secret `CLOUDFLARE_API_TOKEN`;
- environment variable `CLOUDFLARE_ACCOUNT_ID`.

The existing `CHAT_ALLOWED_EMAILS` staging variable must contain at least one human administrator. The bootstrap refuses to enable Access without preserving human access.

## Giant-step execution

After the two values above exist, trigger the prepared workflow by creating or updating:

`.ops-trigger/cloudflare-access`

on branch:

`ops/cloudflare-access-bootstrap`

The workflow `.github/workflows/bootstrap-cloudflare-staging-access.yml` then performs one controlled sequence:

1. finds or creates the self-hosted Access application for `chat-staging.ailucy.online`;
2. preserves an existing human Allow policy, or creates a managed email Allow policy first;
3. finds, creates, or rotates the dedicated `chat-v2-staging-e2e` service token;
4. stores the one-time Client Secret only in `/opt/chat-v2/staging/secrets/cloudflare-access-staging.json` with mode `0600`;
5. creates or updates the application-specific Service Auth policy;
6. reads the application audience and organization authentication domain;
7. redeploys exact Chat V2 SHA `7327a8a512a7d64da5a21be9e81063ef45e0f890` to isolated staging with origin JWT verification;
8. runs local and public browser tests for links, upload/download, persistence, Letta PDF understanding, Gemma image understanding, and Hermes generated-file return;
9. uploads rollback and browser evidence;
10. closes Issue #53 only after every public gate succeeds.

## Safety boundaries

- The workflow never prints the service Client Secret.
- The API token remains a GitHub environment secret and is not copied to the application container.
- A human Allow policy is created before the Service Auth policy when no human policy exists.
- Existing unrelated policies are preserved.
- The generated service credential is staging-only and stored outside the repository.
- No production deployment or merge is included.
- Any bootstrap, preflight, deployment, model, or public E2E failure leaves Issue #53 open.
