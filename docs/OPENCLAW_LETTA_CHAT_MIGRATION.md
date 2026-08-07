# Letta Lucy + OpenClaw Chat Migration

## Architecture decision

Chat continues to present **[Letta] Lucy** as the cognitive identity. OpenClaw is the execution fabric behind that identity; it is not a replacement persona and must not own Lucy's long-term identity or memory.

The runtime boundary is:

```text
Chat V2
  -> [Letta] Lucy conversation identity
  -> private OpenClaw Gateway agent endpoint
  -> Letta-backed Lucy cognition/session
  -> OpenClaw execution fabric
       workers / tools / tasks / scheduler / approvals / audit
```

This follows the canonical control-plane architecture in `since98kr/lucy-openclaw-control`: Letta Lucy owns identity, memory, judgment, planning, orchestration and acceptance, while OpenClaw owns execution-runtime concerns.

## Why the old Letta bridge proof is no longer the target architecture

The existing Chat staging lane was built to prove that a standalone Letta CLI bridge could execute local tools directly. That produced increasingly specialized filesystem, loopback and HMAC probes.

After the OpenClaw integration, side-effecting execution belongs to the OpenClaw execution plane. Letta-native approval-required tools are currently fail-safe denied while the native approval bridge is being verified. Therefore an HMAC proving direct Letta Bash execution must not remain the completion criterion for the OpenClaw-backed path.

The old native bridge remains available as a fallback until the new path passes exact-main staging. It is not removed by this migration patch.

## Chat transport mode

Set the Letta adapter to the explicit OpenClaw mode:

```text
LETTA_PROTOCOL=openclaw
LETTA_BASE_URL=http://<private-openclaw-gateway-host>:<port>
LETTA_CHAT_PATH=/v1/chat/completions
LETTA_HEALTH_PATH=/health
LETTA_API_KEY=<gateway credential reference>
LETTA_OPENCLAW_AGENT_TARGET=openclaw/<explicit-agent-id>
LETTA_OPENCLAW_SESSION_PREFIX=chat-v2
```

`LETTA_OPENCLAW_AGENT_TARGET` is mandatory. Do not silently route `[Letta] Lucy` to whichever OpenClaw agent happens to be the current default.

The adapter sends `user=chat-v2:<conversation-id>` so every Chat Conversation has a stable OpenClaw agent session. It sends only the current user turn plus explicitly approved memory capsules and current attachments; it does not replay the entire Chat transcript into an already persistent OpenClaw session.

## Security boundary

The OpenClaw Gateway OpenAI-compatible endpoint is an operator/client surface. A shared bearer token can represent broad Gateway operator authority. Therefore:

- keep the Gateway on loopback, tailnet, or another private authenticated ingress;
- never expose the Gateway credential to the browser;
- store it only in the server-side deployment secret path;
- do not use a public Cloudflare route directly to the Gateway;
- do not weaken OpenClaw approvals to make Chat tests pass;
- keep Letta `permissionMode=standard` while the native approval bridge remains unverified;
- side-effecting work should use OpenClaw policy, approval and audit surfaces.

## Session and duplicate-delivery contract

A Chat Conversation maps to one stable OpenClaw session key through the OpenAI-compatible `user` field. This is intentionally independent from Chat's internal workflow run and idempotency identifiers.

Before enabling this transport in staging, the parallel OpenClaw/Letta session work must prove:

- one Chat user message produces one OpenClaw inbound turn;
- no `approval_conflict` recovery causes a second provider POST that resends the same prompt;
- no visible `×2` duplicate message;
- no `User interrupted the stream` caused by replay;
- a genuinely new follow-up can still queue behind an active run.

## New acceptance evidence

For `LETTA_PROTOCOL=openclaw`, release evidence should prove the execution fabric rather than direct Letta shell ownership:

1. OpenClaw `/health` is live on the private route.
2. The configured `LETTA_OPENCLAW_AGENT_TARGET` resolves to the intended Lucy route.
3. Two Chat turns in the same Conversation share the same OpenClaw session and preserve Lucy continuity.
4. A harmless read-only OpenClaw-backed tool/worker operation completes.
5. Evidence correlates the Chat conversation/operation with available OpenClaw task, run, session and audit identifiers.
6. Approval-required side effects are denied or approved by OpenClaw policy; Chat never fabricates approval success.
7. No raw tool arguments, credentials, private paths or audit payloads are streamed to the browser.
8. Attachments and generated-artifact behavior are verified independently.

The legacy `verified HMAC tool probe` is not sufficient evidence for this path and should be retired from the OpenClaw-mode staging gate after the new E2E is proven.

## Rollout order

1. Merge transport support with no staging configuration change.
2. Finish the OpenClaw/Letta duplicate-delivery and approval-recovery E2E in the control repo.
3. Read-only verify the deployed OpenClaw agent target and private Gateway endpoint.
4. Enable the Gateway OpenAI-compatible endpoint if it is not already enabled.
5. Configure staging-only `LETTA_PROTOCOL=openclaw` and the explicit agent target/credential.
6. Run exact-main Chat staging E2E for identity, session continuity, safe tool execution, artifacts and redaction.
7. Only after success, remove the old Letta full-CLI bridge rollout/HMAC proof from the OpenClaw-mode release gate.
8. Production remains a separate approval gate.
