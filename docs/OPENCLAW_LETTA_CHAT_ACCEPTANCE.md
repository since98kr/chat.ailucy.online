# OpenClaw-backed Letta Chat acceptance gate

This checklist replaces the standalone Letta-local-tool HMAC proof **only when** `LETTA_PROTOCOL=openclaw` is enabled and the new path has passed staging.

- [ ] private OpenClaw `/health` returns live
- [ ] explicit `LETTA_OPENCLAW_AGENT_TARGET` resolves to Lucy
- [ ] same Chat Conversation reuses one OpenClaw session
- [ ] two-turn Lucy continuity passes without full-history replay
- [ ] one harmless OpenClaw-backed read-only execution passes
- [ ] no duplicate inbound turn during approval recovery
- [ ] approval-required side effect remains denied or OpenClaw-approved
- [ ] no raw credentials/tool arguments/private paths reach Chat
- [ ] attachment input passes
- [ ] generated artifact contract passes or remains explicitly unsupported
- [ ] evidence links Chat conversation/operation to available OpenClaw task/run/session/audit identifiers

Do not delete or disable the legacy native Letta staging lane until every checked item above has exact-main evidence.
