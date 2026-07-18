# Giant Step 7 Scope

This phase delivers the complete Phase 2 foundation for Hermes multi-agent collaboration in one integrated change set.

## Included

- Persistent agent registry for Letta and Hermes.
- Conversation-scoped participants and roles.
- Direct conversations with enabled Hermes subagents.
- `@mention` parsing and explicit routing metadata.
- Team activity timeline with agent task states.
- Preservation of original subagent outputs alongside Lucy summaries.
- Per-conversation participation controls.
- Capability discovery and adapter routing metadata.
- API, database migration, UI, browser tests, container smoke tests, and documentation.

## Safety boundaries

- No production deployment.
- No automatic execution of external tools or irreversible actions.
- Participation and routing are explicit and persisted.
- Letta and Hermes memory boundaries remain isolated.
