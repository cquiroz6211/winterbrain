# Company Brain Architecture

The MVP is a hosted MCP gateway that lets Claude, Codex, and future agents save and query business knowledge through a small set of company-brain tools.

## Architecture summary

```text
Claude/Codex agents
  -> hosted company-brain MCP gateway
  -> MarkItDown normalization
  -> structured extraction
  -> Markdown source of truth
  -> GBrain / knowledge backend
```

## Components

| Component | Responsibility | MVP status |
| --- | --- | --- |
| MCP gateway | Exposes business tools like `ingest_meeting` and `ask_brain` to agents. | Local stdio TypeScript skeleton. |
| MarkItDown | Converts PDFs, decks, docs, spreadsheets, images, audio, HTML, CSV/JSON/XML, ZIPs, YouTube URLs, and EPUB files to Markdown. | TODO: wire to hosted gateway. |
| Structured extraction | Turns normalized Markdown into reusable business knowledge: decisions, priorities, risks, commitments, client learnings, investor insights, and next actions. | TODO: define extraction prompts/schemas. |
| Markdown source of truth | Keeps human-readable artifacts that can be reviewed, versioned, migrated, and reprocessed. | Local `brain/markdown` and `brain/knowledge` folders. |
| GBrain / knowledge backend | Stores indexed knowledge and answers questions across clients, sectors, meetings, and decisions. | TODO: connect after local flow is validated. |

## Data flow

1. A user asks an agent to save a meeting, chat, note, or decision.
2. The agent calls the company-brain MCP tool.
3. The gateway stores raw input or a reference under `brain/raw`.
4. MarkItDown converts supported source files into Markdown under `brain/markdown`.
5. The extraction layer creates structured knowledge records under `brain/knowledge`.
6. The knowledge backend indexes those records for future questions.

## API surface contract

| API Status | Affected Surfaces | Compatibility Impact | Required Evidence | Archive Gate |
| --- | --- | --- | --- | --- |
| `api_changed` | MCP tools: `save_note`, `save_chat_summary`, `ingest_meeting`, `ask_brain` | Non-breaking initial public tool surface | `docs/MCP_TOOLS.md`, `src/server.ts` | pass for scaffold |

Persistence Evidence:

- `decision_record`: `docs/ARCHITECTURE.md`
- `engram_ref`: pending session memory save
- `repo_ref`: MCP tool schemas in `src/server.ts`; plain-language contract in `docs/MCP_TOOLS.md`
- `verify_ref`: lightweight TypeScript syntax/build check when dependencies are available

## Deliberate non-goals for MVP

- No per-user or per-client permission model.
- No complex workflow engine.
- No fully automated CRM replacement.
- No final extraction ontology before real meetings are tested.

The MVP should prove that captured conversations become reusable company knowledge before adding heavier platform features.
