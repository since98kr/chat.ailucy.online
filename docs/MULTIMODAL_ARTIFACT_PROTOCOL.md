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
      "filename": "report.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 128,
      "content_base64": "...",
      "text": "optional bounded text extracted by Chat V2"
    }
  ],
  "metadata": {
    "artifact_count": 1
  }
}
```

Native backends may use the extracted `text` directly or decode `content_base64` for backend-native multimodal processing. They must not request or rely on a Chat V2 filesystem path.

For the current Letta native bridge, supported document text is injected into the current user turn inside a delimited `<ATTACHMENTS>` block. Unsupported binary input fails unless the native binary capability is explicitly implemented and enabled.

### Document extraction

Chat V2 extracts bounded text before calling the AI backend from:

- plain text, Markdown, CSV, and other `text/*` files;
- JSON, XML, YAML, and related textual application types;
- text-based PDF files through PDF.js;
- DOCX files through Mammoth raw-text extraction.

The original uploaded file remains unchanged and downloadable. Only extracted text is inserted into model context.

Chat V2 does not perform OCR. An image-only or scanned PDF with no extractable text fails explicitly instead of being reported as understood.

### OpenAI-compatible payload

Extracted document text is appended to the current user turn inside a delimited attachment block. Supported image formats are sent as `image_url` data URIs in the current user content array.

Supported image MIME types for the OpenAI-compatible path:

- `image/gif`
- `image/jpeg`
- `image/png`
- `image/webp`

Unsupported binary types fail explicitly. They are never silently omitted.

## Output contract

### Native Chat V2 event

A backend may return a generated file as an NDJSON or SSE event:

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

### OpenAI function tool

When `<SYSTEM>_ARTIFACT_TOOL_ENABLED=true`, Chat V2 advertises a `return_artifact` function tool. The model supplies:

```json
{
  "filename": "analysis.md",
  "mime_type": "text/markdown",
  "content_text": "# Analysis"
}
```

`content_base64` may be used instead of `content_text`. Streamed tool-call argument fragments are accumulated and validated before any file is persisted. This flag remains disabled until the selected backend models are verified to accept function tools.

### Chat V2 persistence

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

- uploaded file: 50 MiB (`CHAT_MAX_UPLOAD_BYTES=52428800`);
- one file transferred to a backend: 10 MiB;
- aggregate files transferred in one turn: 20 MiB;
- source document bytes accepted for one Letta extraction turn: 10 MiB;
- extracted document text: 2,000,000 characters;
- PDF pages: 200;
- one generated artifact: 50 MiB.

Runtime variables:

- `CHAT_MAX_EXTRACTED_TEXT_CHARACTERS`
- `CHAT_MAX_PDF_PAGES`
- `CHAT_MAX_GENERATED_ARTIFACT_BYTES`
- `LETTA_MAX_ARTIFACT_BYTES`
- `LETTA_MAX_ARTIFACT_TOTAL_BYTES`
- `LETTA_MAX_TEXT_ARTIFACT_BYTES`
- `LETTA_NATIVE_BINARY_ARTIFACTS`
- `LETTA_ARTIFACT_TOOL_ENABLED`
- `HERMES_MAX_ARTIFACT_BYTES`
- `HERMES_MAX_ARTIFACT_TOTAL_BYTES`
- `HERMES_ARTIFACT_TOOL_ENABLED`

## Backend capability matrix

| Backend path | TXT/MD/JSON/XML/YAML | Text PDF | DOCX | Image | Other binary | Generated file |
|---|---:|---:|---:|---:|---:|---:|
| Hermes OpenAI-compatible | yes | extracted text | extracted text | model-dependent | explicit failure | native event or optional function tool |
| Letta native bridge | current-turn context | extracted text | extracted text | explicit failure by default | explicit failure by default | native event required |
| Generic native adapter | extracted text plus bytes | extracted text plus bytes | extracted text plus bytes | capability flag required | capability flag required | artifact event |

A green transport test is not evidence of AI understanding. Release E2E must place a marker only inside the attachment and require the backend response to reproduce it.

## Required release evidence

1. A marker contained only in a PDF is reproduced by real Letta.
2. A marker contained only in a PNG is reproduced by a multimodal Hermes lane.
3. PDF and DOCX extractors pass deterministic unit tests.
4. An AI-generated TXT file is returned, persisted, reloaded, and downloaded byte-for-byte.
5. A generated image path is validated before claiming image-generation output support.
6. Unsupported MIME, image-only PDF, oversize input, and extraction-limit failures are visible and explicit.
7. The same required cases pass through the public Cloudflare Access hostname when the external gate is enabled.
