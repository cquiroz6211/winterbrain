import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildMarkdownDocument, todayIsoDate } from './markdown.js';
import {
  brainFolders,
  buildKnowledgeFileName,
  ensureBrainFolders,
  readKnowledgeMarkdownFiles,
  writeMarkdownFile,
} from './paths.js';

const server = new McpServer({
  name: process.env.MCP_SERVER_NAME || 'company-brain',
  version: process.env.MCP_SERVER_VERSION || '0.1.0',
});

const tagsSchema = z.array(z.string()).default([]);

server.registerTool(
  'save_note',
  {
    title: 'Save Business Note',
    description: 'Save a business note, learning, investment insight, product note, client note, or decision to the company brain.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().min(1),
        author: z.string().optional(),
        client: z.string().optional(),
        kind: z.enum(['decision', 'learning', 'client_note', 'investment_note', 'product_note']).default('client_note'),
        tags: tagsSchema,
      },
  },
  async ({ title, body, author, client, kind, tags }) => {
    const date = todayIsoDate();
    const markdown = buildMarkdownDocument({
      title,
      frontmatter: {
        type: kind,
        title,
        client,
        author,
        tags,
        created_at: new Date().toISOString(),
      },
      sections: [
        { heading: 'Note', body },
        { heading: 'TODO', body: 'Wire this record to structured extraction and the GBrain knowledge backend.' },
      ],
    });

    const filePath = await writeMarkdownFile(brainFolders.decisions, buildKnowledgeFileName(title, date, client), markdown);

    return textResponse(`Saved note to ${filePath}`);
  },
);

server.registerTool(
  'save_chat_summary',
  {
    title: 'Save Chat Summary',
    description: 'Save a useful business conversation summary to the company brain.',
      inputSchema: {
        title: z.string().min(1),
        summary: z.string().min(1),
        source: z.string().optional(),
        participants: z.array(z.string()).default([]),
        client: z.string().optional(),
        nextActions: z.array(z.string()).default([]),
        tags: tagsSchema,
      },
  },
  async ({ title, summary, source, participants, client, nextActions, tags }) => {
    const date = todayIsoDate();
    const markdown = buildMarkdownDocument({
      title,
      frontmatter: {
        type: 'chat_summary',
        title,
        client,
        source,
        participants,
        tags,
        created_at: new Date().toISOString(),
      },
      sections: [
        { heading: 'Summary', body: summary },
        { heading: 'Participants', body: participants.length ? participants : ['Not provided'] },
        { heading: 'Next Actions', body: nextActions.length ? nextActions : ['Not provided'] },
        { heading: 'TODO', body: 'Extract decisions, commitments, and reusable learnings from this chat.' },
      ],
    });

    const filePath = await writeMarkdownFile(brainFolders.chats, buildKnowledgeFileName(title, date, client), markdown);

    return textResponse(`Saved chat summary to ${filePath}`);
  },
);

server.registerTool(
  'ingest_meeting',
  {
    title: 'Ingest Meeting',
    description: 'Save a meeting record or transcript that is already available as text or Markdown.',
      inputSchema: {
        title: z.string().min(1),
        content: z.string().min(1),
        uploadedBy: z.string().optional(),
        client: z.string().optional(),
        meetingDate: z.string().optional(),
        participants: z.array(z.string()).default([]),
        source: z.string().optional(),
        tags: tagsSchema,
      },
  },
  async ({ title, content, uploadedBy, client, meetingDate, participants, source, tags }) => {
    const date = meetingDate || todayIsoDate();
    const fileName = buildKnowledgeFileName(title, date, client);

    const normalizedMarkdown = buildMarkdownDocument({
      title,
      frontmatter: {
        type: 'meeting_markdown',
        title,
        client,
        meeting_date: date,
        uploaded_by: uploadedBy,
        participants,
        source,
        tags,
      },
      sections: [{ heading: 'Normalized Meeting Content', body: content }],
    });

    const knowledgeMarkdown = buildMarkdownDocument({
      title,
      frontmatter: {
        type: 'meeting',
        title,
        client,
        meeting_date: date,
        uploaded_by: uploadedBy,
        participants,
        source,
        tags,
        created_at: new Date().toISOString(),
      },
      sections: [
        { heading: 'Executive Summary', body: 'TODO: generate structured summary from normalized meeting content.' },
        { heading: 'Priorities', body: ['TODO: extract business priorities.'] },
        { heading: 'Decisions', body: ['TODO: extract decisions.'] },
        { heading: 'Risks', body: ['TODO: extract risks.'] },
        { heading: 'Follow-ups', body: ['TODO: extract owners and next actions.'] },
        { heading: 'Source Notes', body: content },
      ],
    });

    const markdownPath = await writeMarkdownFile(brainFolders.markdown, fileName, normalizedMarkdown);
    const knowledgePath = await writeMarkdownFile(brainFolders.meetings, fileName, knowledgeMarkdown);

    return textResponse(`Saved meeting markdown to ${markdownPath}\nSaved meeting knowledge record to ${knowledgePath}`);
  },
);

server.registerTool(
  'ask_brain',
  {
    title: 'Ask Company Brain',
    description: 'Ask a business question over local Markdown knowledge. Placeholder until GBrain retrieval is wired.',
      inputSchema: {
        question: z.string().min(1),
        client: z.string().optional(),
        tags: tagsSchema,
        limit: z.number().int().min(1).max(20).default(5),
      },
  },
  async ({ question, client, tags, limit }) => {
    const files = await readKnowledgeMarkdownFiles();
    const queryTerms = [...question.split(/\s+/), client, ...tags]
      .filter((term): term is string => Boolean(term && term.trim()))
      .map((term) => term.toLowerCase());

    const matches = files
      .map((file) => ({ file, score: scoreContent(file.content, queryTerms) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (matches.length === 0) {
      return textResponse('No local knowledge records matched yet. TODO: wire semantic retrieval through GBrain.');
    }

    const answer = [
      'Local placeholder search results:',
      '',
      ...matches.map((match) => `- ${match.file.path} (score: ${match.score})`),
      '',
      'TODO: replace this with a synthesized answer from the knowledge backend.',
    ].join('\n');

    return textResponse(answer);
  },
);

async function main(): Promise<void> {
  await ensureBrainFolders();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Company Brain MCP server running on stdio');
}

function scoreContent(content: string, queryTerms: string[]): number {
  const lowerContent = content.toLowerCase();
  return queryTerms.reduce((score, term) => score + (lowerContent.includes(term) ? 1 : 0), 0);
}

function textResponse(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

main().catch((error: unknown) => {
  console.error('Fatal error in Company Brain MCP server:', error);
  process.exit(1);
});
