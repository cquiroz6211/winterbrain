# Ingestion Pipeline

The ingestion pipeline converts scattered meeting and chat material into durable company knowledge.

## Pipeline overview

```text
raw source
  -> normalized Markdown
  -> structured knowledge
  -> indexed answers
```

## Stages

| Stage | Folder | Purpose |
| --- | --- | --- |
| Raw | `brain/raw` | Original uploads or references to source files. May include transcripts, PDFs, decks, audio references, or exported chats. |
| Markdown | `brain/markdown` | MarkItDown output or user-provided Markdown. This is the readable source-of-truth layer. |
| Knowledge | `brain/knowledge` | Business-ready artifacts organized as meetings, chats, decisions, and future extracted entities. |

## Why raw Markdown alone is insufficient

Markdown is necessary but not enough.

Raw Markdown preserves content, but business users need reusable answers:

- What was decided?
- What changed since the last meeting?
- What risks were mentioned?
- What should we prioritize?
- Which client or startup does this affect?
- Which sector pattern does this connect to?
- What follow-up does the CEO need to see?

The structured extraction layer should convert normalized Markdown into fields and sections that agents can reliably retrieve.

## Proposed folder structure

```text
brain/
  raw/
    .gitkeep
  markdown/
    .gitkeep
  knowledge/
    meetings/
      .gitkeep
    chats/
      .gitkeep
    decisions/
      .gitkeep
```

## File naming convention

Use names that are stable, sortable, and readable:

```text
YYYY-MM-DD-client-or-startup-title.md
```

Examples:

```text
2026-06-26-client-x-growth-priorities.md
2026-06-26-healthtech-sector-patterns.md
2026-06-26-pricing-decision.md
```

## Future extraction targets

- Decisions
- Priorities
- Risks
- Opportunities
- Commitments
- Follow-ups
- Client/startup facts
- Investor or market insights
- Cross-client sector patterns
- Open questions

The first production extraction schema should be shaped by real meetings, not guessed in isolation.
