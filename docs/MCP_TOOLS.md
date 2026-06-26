# MCP Tools

The MCP surface should be business-facing. Users should not need to know storage paths, extraction jobs, or backend implementation details.

## Tool contract summary

| Tool | Purpose | Writes/reads |
| --- | --- | --- |
| `save_note` | Save a business note, learning, investment insight, or decision. | `brain/knowledge/decisions` for now. |
| `save_chat_summary` | Save a structured summary of a useful conversation. | `brain/knowledge/chats`. |
| `ingest_meeting` | Save a meeting record or transcript already available as text/Markdown. | `brain/markdown` and `brain/knowledge/meetings`. |
| `ask_brain` | Ask a question over locally stored knowledge. | Reads `brain/knowledge`. |

## `save_note`

Plain-language use:

> “Create this as a note and upload it to the brain.”

Suggested fields:

| Field | Meaning |
| --- | --- |
| `title` | Human-readable note title. |
| `body` | The actual note content. |
| `author` | Person who created or requested the note. |
| `client` | Related client/startup, if any. |
| `tags` | Business tags such as sector, priority, risk, pricing, hiring. |
| `kind` | Note type: decision, learning, client_note, investment_note, or product_note. |

## `save_chat_summary`

Plain-language use:

> “Save this conversation summary in the brain.”

Suggested fields:

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

> “Save Sergio's meeting with Client X in the brain.”

Suggested fields:

| Field | Meaning |
| --- | --- |
| `title` | Meeting title. |
| `content` | Transcript, notes, or Markdown content. |
| `uploadedBy` | Person who uploaded or captured the meeting. |
| `client` | Related client/startup. |
| `meetingDate` | Meeting date in `YYYY-MM-DD` format if known. |
| `participants` | Attendees. |
| `source` | Source file or system reference. |
| `tags` | Retrieval tags. |

## `ask_brain`

Plain-language use:

> “What should we prioritize for Client X based on the meeting Sergio uploaded?”

Suggested fields:

| Field | Meaning |
| --- | --- |
| `question` | Business question to answer. |
| `client` | Optional client/startup focus. |
| `tags` | Optional tags to narrow the search. |
| `limit` | Maximum number of matching records to inspect. |

## Current limitations

- Local file search only; no semantic retrieval yet.
- No MarkItDown conversion call yet.
- No GBrain backend call yet.
- No permission layer yet; MVP assumes all authorized company users can read all knowledge.
