# MCP Tools

The MCP surface should be business-facing. Users should not need to know storage paths, extraction jobs, or backend implementation details.

## Transports

Winterbrain supports two transports, selected by `MCP_TRANSPORT`:

| Transport | Value | Use case |
| --- | --- | --- |
| stdio | `stdio` (default) | Local debug, container launched by the same agent process |
| HTTP | `http` | Remote access for C-levels without local installs. Dokploy deploy. |

When HTTP is selected, additional env vars apply: `PORT` (default 3131), `WINTERBRAIN_PUBLIC_URL`, `WINTERBRAIN_TOKENS`, `WINTERBRAIN_ALLOW_ANONYMOUS`.

## Endpoints (HTTP mode)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mcp` | Initialize session or send JSON-RPC request. Requires `Authorization: Bearer <token>`. |
| `GET` | `/mcp` | Open SSE stream for an existing session. Requires `mcp-session-id` header. |
| `DELETE` | `/mcp` | Terminate an existing session. Requires `mcp-session-id` header. |
| `GET` | `/health` | Healthcheck for Dokploy. Returns JSON with status and active session count. |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth 2.0 Protected Resource Metadata. |

## Auth (HTTP mode)

- Tokens are configured via `WINTERBRAIN_TOKENS`.
- Format: `token1:userId1|scope1|ttlSeconds,token2:userId2|scope2|ttlSeconds,...`.
- `ttlSeconds` is optional. Default: 30 days.
- Example:

  ```bash
  WINTERBRAIN_TOKENS=serge_token:sergio|tools|2592000,marina_token:marina|tools|2592000,ceo_token:dario|tools|31536000
  ```

- Without tokens, the server runs in anonymous mode (only safe for local development). Set `WINTERBRAIN_ALLOW_ANONYMOUS=true` to make this explicit.
- The authenticated `userId` is automatically attached to every tool call as `extra.authInfo.extra.userId`.
- `whoami` returns the current identity for smoke-testing.
- When Mariana calls `save_note` over HTTP, the resulting Markdown has `author: marina` automatically.
- Invalid tokens return `401 Unauthorized` with a `WWW-Authenticate` header.

## Tool contract summary

| Tool | Purpose | Writes/reads |
| --- | --- | --- |
| `whoami` | Return the authenticated identity (HTTP mode). | Reads request context. |
| `save_note` | Save a business note, learning, investment insight, or decision. | `brain/knowledge/decisions`. |
| `save_chat_summary` | Save a structured summary of a useful conversation. | `brain/knowledge/chats`. |
| `ingest_meeting` | Save a meeting record or transcript already available as text/Markdown. | `brain/markdown` and `brain/knowledge/meetings`. |
| `ingest_folder` | Ingest a folder of files; PDFs/DOCX/PPTX/XLSX are normalized via MarkItDown. | `brain/raw`, `brain/markdown`, `brain/knowledge/decisions` (manifest). |
| `ask_brain` | Ask a question over locally stored knowledge. | Reads `brain/knowledge`. |

## `whoami`

Plain-language use:

> "Confirm which user is connected before saving anything."

Returns:

```text
Authenticated as <userId> (clientId=<userId>, scopes=<scopes>)
```

In stdio mode it returns an unauthenticated placeholder.

## `save_note`

Plain-language use:

> "Create this as a note and upload it to the brain."

| Field | Meaning |
| --- | --- |
| `title` | Human-readable note title. |
| `body` | The actual note content. |
| `author` | Person who created the note. Defaults to the authenticated `userId`. |
| `client` | Related client/startup, if any. |
| `tags` | Business tags such as sector, priority, risk, pricing, hiring. |
| `kind` | Note type: decision, learning, client_note, investment_note, or product_note. |

## `save_chat_summary`

Plain-language use:

> "Save this conversation summary in the brain."

| Field | Meaning |
| --- | --- |
| `title` | Summary title. |
| `summary` | Concise recap of the conversation. |
| `source` | Where the conversation happened: Claude, Codex, Slack, email, WhatsApp, etc. |
| `participants` | People or roles involved. |
| `client` | Related client/startup, if any. |
| `nextActions` | Follow-up actions from the conversation. |
| `tags` | Retrieval tags. |

## `ingest_meeting`

Plain-language use:

> "Save Sergio's meeting with Client X in the brain."

| Field | Meaning |
| --- | --- |
| `title` | Meeting title. |
| `content` | Transcript, notes, or Markdown content. |
| `uploadedBy` | Person who uploaded the meeting. Defaults to authenticated `userId`. |
| `client` | Related client/startup. |
| `meetingDate` | Meeting date in `YYYY-MM-DD` format if known. |
| `participants` | Attendees. |
| `source` | Source file or system reference. |
| `tags` | Retrieval tags. |

## `ingest_folder`

Plain-language use:

> "Upload the 'Cliente X' folder to the brain."

| Field | Meaning |
| --- | --- |
| `sourceFolder` | Absolute or project-relative path to the folder. |
| `client` | Client/startup this folder belongs to. |
| `uploadedBy` | Person uploading. Defaults to authenticated `userId`. |
| `notes` | Optional context. |

Behavior:

- Text files (`md`, `txt`, `json`, `csv`, etc.) are copied to `brain/raw/<timestamp>-<client>/`.
- Binary files (`pdf`, `docx`, `pptx`, `xlsx`, images, audio) are converted to Markdown with the official Microsoft MarkItDown (installed inside the Docker image) and saved in `brain/markdown/<timestamp>-<client>/`.
- A manifest is generated in `brain/knowledge/decisions/` with the list of ingested, converted, failed and skipped files.

## `ask_brain`

Plain-language use:

> "What should we prioritize for Client X based on the meeting Sergio uploaded?"

| Field | Meaning |
| --- | --- |
| `question` | Business question to answer. |
| `client` | Optional client/startup focus. |
| `tags` | Optional tags to narrow the search. |
| `limit` | Maximum number of matching records (default 5, max 20). |

Note: search is keyword-based today. Embedding-based retrieval is part of Fase 5 del ROADMAP.

## Current limitations

- HTTP transport requires tokens to be passed in plaintext over HTTPS; rotate tokens regularly.
- No scope-based access control yet. Every authenticated user can read every note (MVP rule).
- No tool-level audit log yet beyond Markdown frontmatter `author`.