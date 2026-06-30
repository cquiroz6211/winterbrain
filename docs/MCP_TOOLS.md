# MCP Tools

The MCP surface should be business-facing. Users should not need to know storage paths, extraction jobs, or backend implementation details.

## Transports

Winterbrain supports two transports, selected by `MCP_TRANSPORT`:

| Transport | Value | Use case |
| --- | --- | --- |
| stdio | `stdio` (default) | Local debug, container launched by the same agent process |
| HTTP | `http` | Remote access for C-levels without local installs. Dokploy deploy. |

When HTTP is selected, additional env vars apply: `PORT` (default 3131), `WINTERBRAIN_PUBLIC_URL`, `WINTERBRAIN_TOKENS`, `WINTERBRAIN_DB_URL`, `WINTERBRAIN_ADMIN_TOKEN`, `WINTERBRAIN_INSTALL_LINK_SECRET`, `WINTERBRAIN_ALLOW_ANONYMOUS`.

## Endpoints (HTTP mode)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mcp` | Initialize session or send JSON-RPC request. Requires `Authorization: Bearer <token>`. |
| `GET` | `/mcp` | Open SSE stream for an existing session. Requires `mcp-session-id` header. |
| `DELETE` | `/mcp` | Terminate an existing session. Requires `mcp-session-id` header. |
| `GET` | `/health` | Healthcheck for Dokploy. Returns JSON with status and active session count. |
| `GET` | `/.well-known/oauth-protected-resource` | OAuth 2.0 Protected Resource Metadata. |
| `GET` | `/admin` | Self-contained token admin page. Available only when `WINTERBRAIN_DB_URL` and `WINTERBRAIN_ADMIN_TOKEN` are set. |
| `GET` | `/admin/api/health` | Admin API health. Requires `Authorization: Bearer <WINTERBRAIN_ADMIN_TOKEN>`. |
| `GET` | `/admin/api/tokens` | List active Postgres-backed tokens. Plain tokens are never returned here. |
| `POST` | `/admin/api/tokens` | Issue a token with `{ "user_id", "ttl_seconds", "label"? }`. Returns `plain_token` once. |
| `GET` | `/admin/api/tokens/:id/install-link` | Return a 24h signed `/install/<jwt>` link for a token issued while `WINTERBRAIN_INSTALL_LINK_SECRET` was set. |
| `POST` | `/admin/api/tokens/:id/revoke` | Revoke a token. |
| `POST` | `/admin/api/tokens/:id/rotate` | Rotate a token. Returns the new `plain_token` once. |
| `GET` | `/install/:tokenOrJwt` | Public tokenized install page. Accepts a direct plain token or a signed install JWT. |

## Auth (HTTP mode)

- Preferred production path: set `WINTERBRAIN_DB_URL` to use the Postgres-backed token store.
- Backwards-compatible path: when `WINTERBRAIN_DB_URL` is empty, tokens are configured via `WINTERBRAIN_TOKENS`.
- `WINTERBRAIN_TOKENS` format: `token1:userId1|scope1|ttlSeconds,token2:userId2|scope2|ttlSeconds,...`.
- `ttlSeconds` is optional for `WINTERBRAIN_TOKENS`. Default: 30 days.
- Example:

  ```bash
  WINTERBRAIN_TOKENS=serge_token:sergio|tools|2592000,marina_token:marina|tools|2592000,ceo_token:dario|tools|31536000
  ```

- Without `WINTERBRAIN_DB_URL` and without `WINTERBRAIN_TOKENS`, the server runs in anonymous mode (only safe for local development). Set `WINTERBRAIN_ALLOW_ANONYMOUS=true` to make this explicit.
- Postgres tokens are stored as SHA-256 hashes. The plain token is shown only once on issue or rotation.
- Install links are bearer-token links. `/install/<plain_token>` works directly without extra configuration. When `WINTERBRAIN_INSTALL_LINK_SECRET` is configured, the admin API can return a signed `/install/<jwt>` link that contains the plain token claim and expires after 24 hours.
- In Postgres mode, the HTTP verifier reads from an in-memory token snapshot refreshed every 30 seconds. Admin issue/revoke/rotate operations refresh the snapshot immediately.
- The authenticated `userId` is automatically attached to every tool call as `extra.authInfo.extra.userId`.
- `whoami` returns the current identity for smoke-testing.
- When Mariana calls `save_note` over HTTP, the resulting Markdown has `author: marina` automatically.
- Invalid tokens return `401 Unauthorized` with a `WWW-Authenticate` header.

### Admin token flow

1. Set `WINTERBRAIN_DB_URL` and `WINTERBRAIN_ADMIN_TOKEN`.
2. Open `/admin` from a browser. The page is standalone HTML/CSS/JS and works on mobile.
3. Paste the admin token. The page stores it in `localStorage` and uses it only as `Authorization: Bearer <admin-token>` for `/admin/api/*` calls.
4. Issue a user token by entering `user_id`, `ttl_seconds`, and an optional label.
5. Copy the plain token immediately. It is never stored in plaintext and will not be shown again.
6. For non-technical users, copy the generated Spanish install message or use the per-row "Copiar link de instalación" button. The install page shows copy buttons for Claude Desktop, Claude Code, and Codex CLI without exposing backend jargon.
7. Use rotate to issue a replacement token for the same user. The previous token stays valid for 24 hours to avoid breaking active sessions.
8. Use revoke to immediately invalidate a token.

### Install link flow

1. Admin issues or rotates a token from `/admin`.
2. The page shows a Spanish message ready for WhatsApp/Slack with `/install/<plain_token>` plus copyable blocks for Claude Desktop, Claude Code, and Codex CLI.
3. If `WINTERBRAIN_INSTALL_LINK_SECRET` is set, the token row can copy `/install/<jwt>`. The JWT is HS256-signed, includes the plain token in the `token` claim, and expires in 24 hours.
4. The user opens the link and clicks the copy button for their app.

Security note: an install link grants the same access as the bearer token inside it. Treat it like a password and revoke or rotate the token after setup if the link may have been forwarded.

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
