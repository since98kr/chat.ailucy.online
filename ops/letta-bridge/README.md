# Lucy Letta Thin Bridge

This bridge exposes the existing local Letta Code Lucy agent to Chat V2 without creating a second agent or moving its MemFS.

## Fixed runtime identity

- Letta Code: `0.28.11`
- Working directory: `/home/since98kr/tei-letta`
- Agent ID: `agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c`
- Local backend: `/home/since98kr/tei-letta/.letta-local`

## API

- `GET /health`
- `POST /v1/chat/stream`
- Bearer authentication is required for chat.
- The service binds only to `127.0.0.1:18283` on `hni-node-04`.

Each Chat V2 `conversation_id` owns one long-running Letta `stream-json` process. Turns are serialized per conversation. A new process receives the supplied Chat V2 history as recovery context; subsequent turns use the retained Letta session. Duplicate user message IDs return the cached final response instead of invoking Lucy twice.

## Install

On `hni-node-04`:

```bash
sudo bash ops/letta-bridge/install-hni-node-04.sh
```

On `agentlucy`, configure passwordless SSH first and install the Docker-gateway-only tunnel:

```bash
ssh-copy-id -p 3004 since98kr@ax.hni-gl.ai
sudo bash ops/letta-bridge/install-agentlucy-tunnel.sh
```

The tunnel binds to Docker's bridge gateway rather than a public interface. Chat V2 reaches it as `http://host.docker.internal:18283`.

## Configure GitHub staging

After the bridge and passwordless SSH are ready, run this once on `agentlucy`:

```bash
bash ops/letta-bridge/configure-github-staging.sh
```

The script creates or updates the `staging` Environment, writes all non-secret Chat/Letta/Hermes variables, and copies the Letta bridge token into the `LETTA_API_KEY` Environment secret without printing it.

## GitHub staging values

```text
LETTA_BASE_URL=http://host.docker.internal:18283
LETTA_CHAT_PATH=/v1/chat/stream
LETTA_HEALTH_PATH=/health
LETTA_AGENT_ID=agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c
LETTA_PROTOCOL=native
LETTA_TIMEOUT_MS=300000
LETTA_MODEL_MAP_JSON={}
```
