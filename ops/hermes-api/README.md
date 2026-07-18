# Hermes native API for Chat V2 staging

Chat V2 uses Hermes Agent's built-in OpenAI-compatible API server. No custom Hermes response bridge is required.

## Runtime identity

- Hermes home: `/home/since98kr/.hermes`
- Hermes executable: `/home/since98kr/.hermes/hermes-agent/venv/bin/hermes`
- API bind: Docker bridge gateway only, normally `172.17.0.1:8642`
- Authentication: `API_SERVER_KEY` from `~/.hermes/.env`
- Advertised model: `hermes-agent`
- Chat V2 display agent: `[Hermes] Lucy`

The GitHub staging model map converts `[Hermes] Lucy` to `hermes-agent`.

## Install on agentlucy

```bash
sudo bash ops/hermes-api/install-agentlucy-api.sh
```

The installer:

1. preserves unrelated `~/.hermes/.env` entries;
2. enables the built-in API server;
3. binds it only to Docker's bridge gateway;
4. creates or preserves a random bearer key;
5. installs `hermes-gateway.service` as a system service running as `since98kr`;
6. verifies authenticated `/health` before returning success.

## Verify

```bash
sudo systemctl --no-pager --full status hermes-gateway

KEY="$(sed -n 's/^API_SERVER_KEY=//p' ~/.hermes/.env | tail -n1)"
curl -fsS -H "Authorization: Bearer ${KEY}" http://172.17.0.1:8642/health
curl -fsS -H "Authorization: Bearer ${KEY}" http://172.17.0.1:8642/v1/models
unset KEY
```

## GitHub staging configuration

After the API is healthy, run on `agentlucy`:

```bash
CHAT_ALLOWED_EMAILS='since98kr@gmail.com' \
  bash ops/letta-bridge/configure-github-staging.sh
```

This sets:

```text
HERMES_BASE_URL=http://host.docker.internal:8642
HERMES_CHAT_PATH=/v1/chat/completions
HERMES_HEALTH_PATH=/health
HERMES_AGENT_ID=[Hermes] Lucy
HERMES_PROTOCOL=openai
HERMES_MODEL_MAP_JSON={"[Hermes] Lucy":"hermes-agent"}
```

It also stores the local `API_SERVER_KEY` as the GitHub Environment secret `HERMES_API_KEY` without printing the value.
