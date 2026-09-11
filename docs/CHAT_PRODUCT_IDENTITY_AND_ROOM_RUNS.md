# Chat product identity and room-run contract

Canonical work package: #229.

## Product identities

- The personal Lucy product identity is **OpenClaw Lucy**. `letta` remains only as a legacy persistence/transport compatibility key where existing schemas and `LETTA_*` deployment settings still require it; it must not remain the user-facing personal system identity.
- **ChatGPT Lucy** is an external room-participant capability backed by the OAuth-protected MCP surface merged in #226. It participates only when an actual ChatGPT session is connected to that MCP surface; source availability does not imply that runtime OAuth/MCP activation is currently enabled.
- ChatGPT Lucy is not an always-on server-side model adapter and must not be presented as one.
- Hermes and Claude retain their existing native identities.

## Room execution lifetime

Outcome C was completed independently by #231 and is part of this PR's base. A response run belongs to its Conversation, not to the currently visible screen.

- navigating away from a Conversation does not cancel its run;
- selecting another Conversation does not reuse or overwrite the first Conversation's controller;
- stream events can update the visible transcript only when the event's Conversation is currently selected;
- streaming deltas remain durable on the server and are recovered when a Conversation is re-opened;
- explicit **Stop** cancels only the currently visible Conversation's run;
- separate Conversations may own separate in-flight controllers.

This PR completes the remaining source-only product-identity and connected-participant surfaces. Runtime MCP/OAuth enablement remains a separate deployment/security action.
