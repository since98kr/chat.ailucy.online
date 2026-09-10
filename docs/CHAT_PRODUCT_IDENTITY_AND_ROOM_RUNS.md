# Chat product identity and room-run contract

Canonical work package: #229.

## Product identities

- The personal Lucy product identity is **OpenClaw Lucy**. Letta is legacy implementation/history vocabulary and must not remain the user-facing personal system identity.
- **ChatGPT Lucy** is a connected external room participant backed by the OAuth-protected MCP surface merged in #226. It is not an always-on server-side model adapter and must not be presented as one.
- Hermes and Claude retain their existing native identities.

## Room execution lifetime

A response run belongs to its Conversation, not to the currently visible screen.

- navigating away from a Conversation does not cancel its run;
- selecting another Conversation does not reuse or overwrite the first Conversation's controller;
- stream events can update the visible transcript only when the event's Conversation is currently selected;
- streaming deltas remain durable on the server and are recovered when a Conversation is re-opened;
- explicit **Stop** cancels only the currently visible Conversation's run;
- separate Conversations may own separate in-flight controllers.

This contract is source-only until the normal exact-head CI/review/deployment gates are completed.
