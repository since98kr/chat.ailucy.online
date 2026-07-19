# Multimodal and Generated Artifact Protocol

## Purpose

Chat V2 must distinguish four different states that were previously conflated:

1. a file was uploaded to Chat V2;
2. the file was attached to a user message;
3. the selected AI backend actually received and could interpret it;
4. an AI backend returned a generated file that Chat V2 persisted and exposed to the user.

The protocol below makes states 3 and 4 explicit and testable.

## Input contract

The internal adapter request contains the persisted `ArtifactRecord[]` associated with the current user message. The HTTP adapter reads the bytes from Chat V2 storage only after validating the configured per-file and aggregate limits.

### Native HTTP payload

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Summarize the attachment",
      "message_id": "uuid"
    }
  ],
  "artifacts": [
    {
      "artifact_id": "uuid",
      "filename": "report.txt",
      "mime_type": "text/plain",
      "size_bytes": 128,
      "content_base64": "...",
      "text": "optional UTF-8 text representation"
    }
  ],
  "metadata": {
    "artifact_count": 1
  }
}
```

Native backends may use `text` directly for supported textual formats or decode `content_base64` for model-native multimodal processing. They must not request or rely on the Chat V2 filesystem path.

### OpenAI-compatible payload

Text attachments are appended to the current user turn inside a delimited attachment block. Supported image formats are sent as `image_url` data URIs in the current user content array.

Supported image MIME types for the OpenAI-compatible path:

- `image/gif`
- `image/jpeg`
- `image/png`
- `image/webp`

Unsupported binary types fail explicitly. They are never silently omitted.

## Output contract

A backend returns a generated file as an NDJSON or SSE event:

```json
{
  "type": "artifact.created",
  "artifact": {
    "filename": "analysis.md",
    "mime_type": "text/markdown",
    "content_base64": "..."
  }
}
```

For text output, `content_text` may be supplied instead of `content_base64`.

Chat V2 then:

1. validates that inline content exists;
2. decodes canonical base64 or UTF-8 text;
3. enforces the generated-artifact size limit;
4. normalizes active document MIME types;
5. generates its own storage filename;
6. persists the file through the Chat Artifact Service;
7. attaches it to the assistant message;
8. emits `artifact.created` to the browser.

Backends cannot return a local path or remote URL as a trusted file reference.

## Limits

Default limits:

- uploaded file: `CHAT_MAX_UPLOAD_BYTES=52428800`
- one file transferred to a backend: `100663296` is not the default; the adapter default is 10 MiB
- aggregate files transferred in one turn: adapter default 20 MiB
- one generated artifact: adapter default 50 MiB

Runtime variables:

- `LETTA_MAX_ARTIFACT_BYTES`
- `LETTA_MAX_ARTIFACT_TOTAL_BYTES`
- `HERMES_MAX_ARTIFACT_BYTES`
- `HERMES_MAX_ARTIFACT_TOTAL_BYTES`
- `CHAT_MAX_GENERATED_ARTIFACT_BYTES`

## Backend capability matrix

| Backend path | Text document | Image | Other binary | Generated file |
|---|---:|---:|---:|---:|
| Hermes OpenAI-compatible | yes | model-dependent | explicit failure | custom artifact event required |
| Letta native bridge | text context required | bridge/model capability required | explicit failure unless implemented | native artifact event required |
| Generic native adapter | backend-defined | backend-defined | backend-defined | artifact event |

A green transport test is not evidence of AI understanding. Release E2E must place a marker only inside the attachment and require the backend response to reproduce it.

## Required release evidence

1. TXT or Markdown marker understood by Letta.
2. TXT or Markdown marker understood by Hermes.
3. PNG marker understood by a multimodal Hermes lane.
4. AI-generated TXT returned, persisted, reloaded, and downloaded byte-for-byte.
5. AI-generated PNG returned, rendered, reloaded, and downloaded byte-for-byte.
6. Unsupported MIME and oversize failures are visible to the user.
7. The same cases pass through the public Cloudflare Access hostname when the external gate is required.
