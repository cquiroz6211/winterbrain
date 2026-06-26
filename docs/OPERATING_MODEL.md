# Operating Model

The company brain works when business users can capture knowledge without changing how they already work. The MCP should make saving and querying knowledge feel like a natural Claude/Codex instruction.

## MVP rule: everyone can see everything

For the MVP, every authorized company user can read all company-brain knowledge.

This is intentional:

- It keeps the first version simple.
- It encourages cross-client and cross-sector learning.
- It avoids premature permission design before usage patterns are clear.
- It helps executives, operators, and partners reuse knowledge from each other.

Future versions can add client-level, role-level, sensitivity-level, or deal-room permissions after the knowledge flow is proven.

## Example roles

| Person | Typical action | Business value |
| --- | --- | --- |
| Sergio | Uploads or summarizes a meeting with Client X. | Captures raw context and relationship details. |
| Mariana | Asks what to prioritize for Client X based on Sergio's meeting. | Turns another person's meeting into actionable priorities. |
| Don Darío / CEO | Asks for portfolio-wide patterns, risks, or opportunities. | Gets strategic signal across clients and startups. |

## Meeting capture workflow

1. User finishes a meeting or receives a transcript.
2. User tells the agent: “save this meeting in the brain.”
3. The agent calls `ingest_meeting` with title, client/startup, participants, date, uploader, and content.
4. The gateway stores a Markdown meeting record.
5. The extraction layer later identifies priorities, decisions, follow-ups, risks, and reusable learnings.

## Chat capture workflow

1. User has a useful conversation in Claude, Codex, Slack, WhatsApp, email, or another channel.
2. User tells the agent: “create this as a note and upload it to the brain.”
3. The agent calls `save_chat_summary` or `save_note`.
4. The record is stored with participants, source, client/startup, tags, and next actions.

## Query workflow

Users ask business questions, not database questions:

- “What should we prioritize for Client X?”
- “What did we learn from recent fintech meetings?”
- “Which portfolio companies have similar hiring problems?”
- “What decisions did we make about pricing last month?”

In the scaffold, `ask_brain` performs simple local Markdown search. In production, it should query GBrain or another indexed knowledge backend.

## Operating principles

- Capture first, refine later.
- Prefer business language over technical labels.
- Keep Markdown records reviewable by humans.
- Preserve source context so extracted knowledge can be audited.
- Avoid permission complexity until the organization has real usage data.
