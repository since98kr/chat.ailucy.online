# Lucy Letta Full CLI Runtime Bridge

This bridge exposes the existing local Lucy CLI runtime to Chat V2 without creating a second agent, moving its MemFS, or replacing its working directory. Chat staging is therefore backed by the same `lucy-routed` command, Letta agent, home directory, environment, skills, tool registry, and MCP configuration used from the CLI.

## Runtime identity

- Working directory: `/home/since98kr/tei-letta`
- Agent ID: `agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c`
- Launcher: `/home/since98kr/.local/bin/lucy-routed`
- Local backend: `/home/since98kr/tei-letta/.letta-local`
- Bridge mode: `full-cli-runtime`

The bridge no longer forces `--memfs-startup skip`. Unless `LETTA_MEMFS_STARTUP` is explicitly configured, Lucy starts with the same MemFS startup behavior chosen by the CLI launcher.

## What “full CLI runtime” means

Each Chat V2 `conversation_id` owns one long-running `lucy-routed` `stream-json` process. That process—not the browser and not the Chat V2 API—loads and executes Lucy's tools, skills, and MCP servers under the existing Lucy OS account and runtime policy.

The bridge:

- captures the CLI initialization event;
- records the exact advertised model identifier;
- records sanitized tool, skill, and MCP server names;
- injects that runtime identity into each Chat V2 turn;
- forwards assistant text;
- forwards only sanitized execution progress such as `tool.running:read_file` and `tool.completed:read_file`;
- reuses the same process across turns;
- caches duplicate Chat V2 user message IDs to prevent duplicate tool execution.

The bridge does **not** expose a remote shell, filesystem API, raw MCP endpoint, tool arguments, tool results, hidden prompts, environment variables, tokens, or private files to the browser.

## API

- `GET /health`
  - unauthenticated liveness and non-secret capability counts;
  - reports `mode: full-cli-runtime`.
- `GET /capabilities`
  - bearer-authenticated;
  - reports exact model ID plus sanitized tool, skill, and MCP server names from an initialized session.
- `POST /v1/chat/stream`
  - bearer-authenticated;
  - streams NDJSON assistant deltas and sanitized runtime/tool status events.

The service binds only to `127.0.0.1:18283` on `hni-node-04`. The existing SSH tunnel publishes it only on the `agentlucy` Docker bridge gateway, not a public interface.

## Install on hni-node-04

```bash
sudo bash ops/letta-bridge/install-hni-node-04.sh
```

The installer preserves an existing bridge bearer token and configuration file, installs `letta-full-bridge.mjs`, restarts the service, and fails unless `/health` reports `full-cli-runtime`.

## Install the private tunnel on agentlucy

Configure passwordless SSH first, then install the Docker-gateway-only tunnel:

```bash
ssh-copy-id -p 3004 since98kr@ax.hni-gl.ai
sudo bash ops/letta-bridge/install-agentlucy-tunnel.sh
```

Chat V2 reaches the bridge as `http://host.docker.internal:18283`.

## Automated staging deployment

The staging workflow runs:

```bash
bash ops/letta-bridge/deploy-from-agentlucy.sh
```

That script transfers only the checked-out bridge and installer files to `hni-node-04`, invokes the installer with the existing passwordless SSH and restricted `sudo` path, and validates bridge health through the Docker gateway. It never prints or copies the bridge token.

After Chat V2 is deployed, Playwright creates a real Letta conversation and requires all of the following:

- a non-empty exact runtime model identifier;
- at least one advertised CLI tool;
- at least one advertised skill;
- at least one advertised MCP server;
- a real `tool.running` or `mcp.running` status;
- a real `tool.completed` status;
- a Lucy answer containing the exact model identifier reported by the bridge;
- no “I do not know” model response.

The workflow then captures authenticated `/capabilities` output as a non-secret evidence artifact.

## Configure the GitHub staging Environment

Run once from an authenticated `gh` session on `agentlucy`:

```bash
bash ops/letta-bridge/configure-github-staging.sh
```

It configures:

```text
CHAT_LETTA_FULL_RUNTIME_QA_REQUIRED=true
LETTA_BASE_URL=http://host.docker.internal:18283
LETTA_CHAT_PATH=/v1/chat/stream
LETTA_HEALTH_PATH=/health
LETTA_AGENT_ID=agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c
LETTA_PROTOCOL=native
LETTA_TIMEOUT_MS=300000
LETTA_MODEL_MAP_JSON={}
LETTA_SSH_HOST=ax.hni-gl.ai
LETTA_SSH_PORT=3004
LETTA_SSH_USER=since98kr
LETTA_BRIDGE_USER=since98kr
```

`LETTA_API_KEY` remains an Environment secret. Its value is read over the private SSH connection and piped directly to `gh secret set`; it is never printed.

## Optional fail-closed requirements

The service environment supports exact capability requirements:

```text
LETTA_REQUIRE_RUNTIME_MODEL=true
LETTA_REQUIRED_TOOLS=["read_file","shell"]
LETTA_REQUIRED_SKILLS=["github"]
LETTA_REQUIRED_MCP_SERVERS=["filesystem","github"]
LETTA_EXTRA_ARGS_JSON=[]
```

Each list may also be comma-separated. When configured, a session is rejected during initialization if the CLI runtime does not advertise every required capability.

## Security boundary

The Chat V2 route intentionally does not grant root or browser-controlled host access. The runtime continues to execute as the existing non-root Lucy account with `NoNewPrivileges=true`, its configured home and working directory, and the existing CLI/MCP authorization policy. Adding a capability to Lucy's CLI configuration makes it available to the same Lucy process; it does not create a separate unauthenticated web endpoint.

## Rollback

The previous thin bridge remains in the repository as `letta-bridge.mjs`. A host operator can temporarily restore it by changing the systemd `ExecStart` back to that file and restarting `letta-bridge.service`. The normal staging workflow will reinstall the full bridge on the next validated deployment.
