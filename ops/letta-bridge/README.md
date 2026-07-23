# Lucy Letta Full CLI Runtime Bridge

This bridge exposes the existing local Lucy CLI runtime to Chat V2 without creating a second agent, moving its MemFS, or replacing its working directory. Chat staging is backed by the same `lucy-routed` launcher, Letta agent, home directory, environment, tool registry, skill sources, slash commands, MCP configuration, and local permission policy used from the CLI.

## Runtime identity

- Working directory: `/home/since98kr/tei-letta`
- Agent ID: `agent-local-0dc7f93b-7b2e-41f3-8193-a9520950557c`
- Launcher: `/home/since98kr/.local/bin/lucy-routed`
- Local backend: `/home/since98kr/tei-letta/.letta-local`
- Canonical bridge: `letta-cli-bridge.mjs`
- Bridge mode: `full-cli-runtime`

The bridge does not force `--memfs-startup skip`. Unless `LETTA_MEMFS_STARTUP` is explicitly configured, Lucy starts with the same MemFS startup behavior selected by the CLI launcher.

## Official stream-json contract

The bridge reads the Letta Code `SystemInitMessage` fields directly:

- `model`
- `tools`
- `cwd` — used only by the CLI process and never returned by the bridge
- `mcp_servers` with connection status
- `permission_mode`
- `slash_commands`
- `memfs_enabled`
- `skill_sources` (`bundled`, `global`, `agent`, `project`)

It does not invent a skill catalog from unrelated fields. The capability response reports the actual skill sources and slash commands advertised by the CLI. Lucy can use the CLI `/skills` capability when it needs to inspect individual loaded skills.

## What “full CLI runtime” means

Each Chat V2 `conversation_id` owns one long-running `lucy-routed` `stream-json` process. That process—not the browser and not the Chat V2 API—loads and executes Lucy's tools, skills, subagents, hooks, and MCP servers under the existing Lucy OS account and permission policy.

The bridge:

- captures and validates the official CLI initialization event;
- records the exact advertised model identifier and permission mode;
- requires MemFS, tools, skill sources, slash commands, and MCP servers by default;
- injects a bounded runtime identity contract into each Chat V2 turn;
- forwards assistant text;
- correlates tool-call IDs with tool execution lifecycle events;
- forwards only sanitized progress such as `tool.running:Read`, `tool.completed:Read`, or `tool.approval_required:Bash`;
- reuses the same process across turns;
- caches duplicate Chat V2 user message IDs to prevent duplicate tool execution.

The bridge does **not** expose a remote shell, filesystem API, raw MCP endpoint, tool arguments, tool results, approval payloads, hidden prompts, environment variables, tokens, private paths, or private files to the browser.

## Permissions and approvals

Letta Code's permission system remains authoritative. Tools already allowed by Lucy's CLI permission rules execute immediately. A protected operation remains protected and is surfaced only as a sanitized approval-required status; the bridge does not bypass permissions or grant root access.

This preserves the requested behavior for ordinary tools while keeping genuinely dangerous actions behind Lucy's existing approval policy.

## API

- `GET /health`
  - unauthenticated liveness and non-secret counts;
  - reports `mode: full-cli-runtime`, model when initialized, permission mode, MemFS state, and capability counts.
- `GET /capabilities`
  - bearer-authenticated;
  - returns the initialized session's exact model, tools, skill sources, slash commands, MCP names/status, permission mode, and MemFS state;
  - returns `503` before a Lucy session has initialized rather than returning misleading empty capability.
- `POST /v1/chat/stream`
  - bearer-authenticated;
  - streams NDJSON assistant deltas and sanitized runtime/tool status events.

The service binds only to `127.0.0.1:18283` on `hni-node-04`. The existing SSH tunnel publishes it only on the `agentlucy` Docker bridge gateway, not a public interface.

## Install on hni-node-04

```bash
sudo bash ops/letta-bridge/install-hni-node-04.sh
```

The installer preserves an existing bearer token and environment file, installs `letta-cli-bridge.mjs`, restarts the service, and fails unless `/health` reports `full-cli-runtime`.

## Install the private tunnel on agentlucy

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

That script transfers only the checked-out canonical bridge and installer to `hni-node-04`, invokes the installer using the existing passwordless SSH and restricted `sudo` path, and validates bridge health through the Docker gateway. It never prints or copies the bridge token.

After Chat V2 is deployed, Playwright creates a real Letta conversation and requires:

- a non-empty exact runtime model identifier;
- a non-unknown permission mode;
- MemFS enabled;
- at least one advertised CLI tool;
- at least one advertised skill source;
- at least one advertised slash command;
- at least one advertised MCP server;
- a real tool running event;
- a real tool completed event;
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

## Fail-closed runtime requirements

The host environment defaults to:

```text
LETTA_REQUIRE_RUNTIME_MODEL=true
LETTA_REQUIRE_TOOLS=true
LETTA_REQUIRE_SKILL_SOURCES=true
LETTA_REQUIRE_MCP_SERVERS=true
LETTA_REQUIRE_SLASH_COMMANDS=true
LETTA_REQUIRE_MEMFS=true
LETTA_REQUIRED_TOOLS=
LETTA_REQUIRED_SKILL_SOURCES=
LETTA_REQUIRED_MCP_SERVERS=
LETTA_REQUIRED_SLASH_COMMANDS=
LETTA_EXTRA_ARGS_JSON=[]
```

The `LETTA_REQUIRED_*` values may be JSON string arrays or comma-separated lists. If configured, a session is rejected during initialization unless every named capability is advertised by the CLI.

## Security boundary

The Chat V2 route intentionally does not grant root or browser-controlled host access. The runtime executes as the existing non-root Lucy account with `NoNewPrivileges=true`, its configured home and working directory, and the existing CLI/MCP authorization policy. Adding a capability to Lucy's CLI configuration makes it available to that same Lucy process; it does not create a separate unauthenticated web endpoint.

## Rollback

The prior thin bridge remains in the repository as `letta-bridge.mjs`. A host operator can temporarily restore it by changing the systemd `ExecStart` to that file and restarting `letta-bridge.service`. The normal staging workflow reinstalls the canonical full CLI bridge on the next validated deployment.
