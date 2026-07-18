# Browser authentication and system status

## Supported browser modes

### Cloudflare Access

Use `CHAT_AUTH_MODE=cloudflare` with `CHAT_ALLOWED_EMAILS`. Cloudflare authenticates the user before traffic reaches Chat V2 and injects the authenticated email header. The application verifies that the email is explicitly allowed.

### Private token session

Use `CHAT_AUTH_MODE=token` with `CHAT_ACCESS_TOKEN` for isolated staging or controlled direct access.

The browser flow is:

1. Read the public authentication mode from `/api/auth/config`.
2. Submit the access value once to `/api/auth/login`.
3. The server validates it with a constant-time comparison.
4. The server returns an HttpOnly, SameSite=Strict session cookie.
5. The raw value is not retained in localStorage, sessionStorage, IndexedDB, or application state after login.
6. All API requests, streaming, uploads, inline images, file downloads, and Markdown exports use the same browser session cookie.

Logout clears the cookie with `Max-Age=0`.

## System Status

The sidebar settings button opens an authenticated status panel backed by `/api/ops/status`.

It shows only non-secret operational facts:

- runtime environment and app version
- abbreviated Git revision
- uptime
- authentication mode and current identity
- Letta and Hermes adapter mode, health detail, and latency

It never returns access tokens, API keys, backend authorization headers, or full environment variables.

## Public endpoints

Only these API routes bypass application authentication:

- `/api/health`
- `/api/auth/config`
- `/api/auth/login`
- `/api/auth/logout`

The health endpoint remains minimal. Detailed runtime information remains protected.

## Validation

CI exercises:

- invalid and valid login attempts
- HttpOnly session-cookie exchange
- cookie-authenticated Conversation and operations requests
- bearer compatibility for automation
- Cloudflare identity allow-list behavior
- authenticated desktop and mobile Chromium flows
- authenticated Markdown download
- logout returning to the login gate
