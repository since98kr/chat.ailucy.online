# OpenClaw Letta Adapter Contract

- Chat-visible identity remains `[Letta] Lucy`.
- Transport target is an explicitly configured OpenClaw agent target.
- One Chat Conversation maps to one stable OpenClaw session through the `user` field.
- The adapter does not claim or synthesize internal OpenClaw tool lifecycle events that the HTTP Chat Completions surface does not expose.
- Backend error frames fail closed.
- Gateway credentials are server-side only.
- Existing native Letta transport remains available until staging proves the OpenClaw path.
