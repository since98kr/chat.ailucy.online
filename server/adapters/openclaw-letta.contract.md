# OpenClaw Letta Adapter Contract

- Chat-visible identity remains `[OpenClaw] Lucy`; legacy Letta transport identity is internal compatibility only.
- Transport target is an explicitly configured OpenClaw agent target.
- One Chat Conversation maps to one stable OpenClaw session through the `user` field and `x-openclaw-session-key`.
- For a Chat run that carries execution correlation, Chat also sends `x-lucy-execution-session-id` and `x-lucy-execution-operation-id` as transport metadata, not prompt instructions. Their logical UTF-8 identities are encoded into a versioned base64url ASCII representation before entering HTTP headers, so non-Latin canonical agent/session names remain valid header values without changing the underlying logical session/operation identity.
- A backend may prove executable work only by emitting an explicit stream frame of type `execution-evidence` whose evidence object includes `kind` (`tool-receipt` or `result-receipt`), the exact echoed encoded session header value, the exact echoed encoded operation header value, and an opaque receipt id. Chat decodes the echoed correlation values before runner verification; legacy/plain ASCII receipt values remain parse-compatible during migration.
- Chat never synthesizes execution evidence from ordinary Chat Completions termination, response ids, generated artifacts, assistant text, or inferred OpenClaw tool lifecycle. If no explicit correlated receipt is emitted, transport completion remains non-verified for operating-context FACT/blocker-clearing purposes.
- Receipt frames are validated again by the collaboration runner against the exact current logical session and operation before the current run id is attached and before any verified completion state is written.
- Backend error frames, malformed explicit receipt frames, and malformed versioned correlation encodings fail closed.
- Gateway credentials are server-side only.
- Existing native Letta transport remains available until staging proves the OpenClaw path.
