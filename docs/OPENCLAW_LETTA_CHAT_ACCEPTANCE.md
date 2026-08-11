# OpenClaw-backed Letta Chat acceptance gate

This checklist replaces the standalone Letta-local-tool HMAC proof **only when** `LETTA_PROTOCOL=openclaw` is enabled and the new path has passed staging.

Evidence baseline: `Deploy staging` on `main` @ `877f5d55`, 2026-08-11 (all steps green).

- [x] private OpenClaw `/health` returns live
      — staging preflight `adapter-letta` reports `mode=http; 200 OK`.
- [x] explicit `LETTA_OPENCLAW_AGENT_TARGET` resolves to Lucy
      — the "Capture authenticated OpenClaw Lucy target evidence" step calls
      `/v1/models` and exits non-zero unless the advertised ids contain the
      configured target. Green means the gateway advertised `agent:lucy`.
- [x] same Chat Conversation reuses one OpenClaw session
      — `scripts/ops/openclaw-letta-staging-smoke.sh` drives both turns through
      a single created Conversation.
- [x] two-turn Lucy continuity passes without full-history replay
      — turn 1 plants a random `CHAT_OPENCLAW_SESSION_*` marker, turn 2 sends
      only the new question and the script fails unless the marker is returned.

The following remain unproven. Do not check them without exact-head evidence.

- [ ] one harmless OpenClaw-backed read-only execution passes
- [ ] no duplicate inbound turn during approval recovery
- [ ] approval-required side effect remains denied or OpenClaw-approved
      — blocked: `deploy-staging.yml` hardcodes
      `CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED: 'false'` in both the browser-smoke
      and the Cloudflare Access steps, so full Letta runtime QA never runs.
- [ ] no raw credentials/tool arguments/private paths reach Chat
      — only partially covered by redaction in the target-evidence step.
- [ ] attachment input passes
      — skipped: repository variable `CHAT_MULTIMODAL_QA_REQUIRED` is undefined.
- [ ] generated artifact contract passes or remains explicitly unsupported
      — skipped: repository variable `CHAT_GENERATED_ARTIFACT_QA_REQUIRED` is undefined.
- [ ] evidence links Chat conversation/operation to available OpenClaw
      task/run/session/audit identifiers
      — the smoke result records only `conversation_id_present`; no OpenClaw
      task, run, session, or audit identifier is captured.

Do not delete or disable the legacy native Letta staging lane until every checked item above has exact-main evidence. As of 2026-08-11 only 4 of 11 are met, so the legacy lane must be retained.
