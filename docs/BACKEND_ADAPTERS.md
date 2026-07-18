# Letta and Hermes backend adapters

Chat V2 keeps backend-specific behavior behind one adapter boundary. If a system's `BASE_URL` is empty, Chat V2 uses its deterministic mock adapter. When configured, the HTTP adapter performs an independent health probe and streams the real backend response.

## Configuration

Each system uses the same variable pattern:

- `<SYSTEM>_BASE_URL`
- `<SYSTEM>_CHAT_PATH`
- `<SYSTEM>_HEALTH_PATH`
- `<SYSTEM>_AGENT_ID`
- `<SYSTEM>_API_KEY`
- `<SYSTEM>_TIMEOUT_MS`

See `config/adapters.env.example`.

## Health probe

Chat V2 sends an authenticated `GET` request to `BASE_URL + HEALTH_PATH`.

`GET /api/health` and `GET /api/adapters/probe` expose normalized status:

```json
{
  "ok": true,
  "mode": "http",
  "detail": "200 OK",
  "latencyMs": 42
}
```

A configured backend that fails its health probe remains visible as unhealthy. Chat V2 does not silently switch a configured production adapter back to mock mode.

## Chat request

The adapter sends a `POST` request to `BASE_URL + CHAT_PATH`:

```json
{
  "stream": true,
  "system_id": "hermes",
  "agent_id": "[Hermes] Lucy",
  "conversation_id": "conversation-uuid",
  "messages": [
    {
      "role": "user",
      "content": "message",
      "author_id": "tei",
      "message_id": "message-uuid"
    }
  ],
  "metadata": {
    "source": "chat.ailucy.online",
    "user_message_id": "message-uuid"
  }
}
```

This payload is deliberately backend-neutral. A backend-specific compatibility route may translate it into Letta or Hermes native calls without coupling the Web UI to either implementation.

## Accepted streaming response formats

The adapter normalizes all of the following:

### NDJSON

```json
{"type":"status","status":"기억을 확인하는 중"}
{"type":"delta","delta":"안녕하세요"}
```

### Server-Sent Events

```text
data: {"delta":"안녕하세요"}

data: [DONE]
```

### OpenAI-compatible chunks

```json
{"choices":[{"delta":{"content":"안녕하세요"}}]}
```

### Simple JSON content

```json
{"content":"안녕하세요"}
```

## Memory boundary

The adapter receives only the selected Conversation transcript. Letta may independently retrieve approved long-term personal memory. Hermes may independently invoke its team. Chat V2 does not merge the two systems' memories or send another Conversation's transcript unless a future explicit Memory Capsule flow is used.

## Security boundary

- API keys are environment secrets and never repository content.
- Health details shown to the browser must not contain credentials.
- Staging binds to localhost by default.
- Production routing remains a separate deployment gate.
- A configured adapter failure is surfaced rather than hidden by automatic fallback.
