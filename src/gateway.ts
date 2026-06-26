import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { buildMarkdownDocument, todayIsoDate } from './markdown.js';
import {
  brainFolders,
  buildKnowledgeFileName,
  ensureBrainFolders,
  ingestFolder,
  readKnowledgeMarkdownFiles,
  writeMarkdownFile,
} from './paths.js';

export interface GatewayServerOptions {
  name?: string;
  version?: string;
}

function resolveUser(extra: { authInfo?: AuthInfo } | undefined): string {
  const info = extra?.authInfo;
  if (!info) return 'unknown';
  const extraUser = info.extra?.userId;
  if (typeof extraUser === 'string') return extraUser;
  return info.clientId;
}

export function buildGatewayServer(options: GatewayServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name || process.env.MCP_SERVER_NAME || 'company-brain',
    version: options.version || process.env.MCP_SERVER_VERSION || '0.2.0',
  });

  const tagsSchema = z.array(z.string()).default([]);

  server.registerTool(
    'whoami',
    {
      title: 'Who Am I',
      description: 'Return the authenticated identity for the current MCP session. Useful to confirm token wiring before saving anything.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const info = extra.authInfo;
      if (!info) {
        return textResponse('Unauthenticated session. In HTTP mode, send a valid bearer token. In stdio mode, this tool runs as the local agent identity.');
      }
      const userId = typeof info.extra?.userId === 'string' ? info.extra.userId : info.clientId;
      return textResponse(`Authenticated as ${userId} (clientId=${info.clientId}, scopes=${info.scopes.join(' ')})`);
    },
  );

  server.registerTool(
    'save_note',
    {
      title: 'Save Business Note',
      description: 'Save a business note, learning, investment insight, product note, client note, or decision to the company brain. The authenticated user is recorded automatically as author unless explicitly overridden.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().min(1),
        author: z.string().optional(),
        client: z.string().optional(),
        kind: z.enum(['decision', 'learning', 'client_note', 'investment_note', 'product_note']).default('client_note'),
        tags: tagsSchema,
      },
    },
    async ({ title, body, author, client, kind, tags }, extra) => {
      const resolvedAuthor = author || resolveUser(extra);
      const date = todayIsoDate();
      const markdown = buildMarkdownDocument({
        title,
        frontmatter: {
          type: kind,
          title,
          client,
          author: resolvedAuthor,
          tags,
          created_at: new Date().toISOString(),
        },
        sections: [
          { heading: 'Note', body },
          { heading: 'TODO', body: 'Wire this record to structured extraction and the GBrain knowledge backend.' },
        ],
      });

      const filePath = await writeMarkdownFile(
        brainFolders.decisions,
        buildKnowledgeFileName(title, date, client),
        markdown,
      );

      return textResponse(`Saved note to ${filePath}\nAuthor: ${resolvedAuthor}`);
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
    async ({ title, summary, source, participants, client, nextActions, tags }, extra) => {
      const resolvedAuthor = resolveUser(extra);
      const date = todayIsoDate();
      const markdown = buildMarkdownDocument({
        title,
        frontmatter: {
          type: 'chat_summary',
          title,
          client,
          source,
          author: resolvedAuthor,
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

      const filePath = await writeMarkdownFile(
        brainFolders.chats,
        buildKnowledgeFileName(title, date, client),
        markdown,
      );

      return textResponse(`Saved chat summary to ${filePath}\nAuthor: ${resolvedAuthor}`);
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
    async ({ title, content, uploadedBy, client, meetingDate, participants, source, tags }, extra) => {
      const resolvedUploader = uploadedBy || resolveUser(extra);
      const date = meetingDate || todayIsoDate();
      const fileName = buildKnowledgeFileName(title, date, client);

      const normalizedMarkdown = buildMarkdownDocument({
        title,
        frontmatter: {
          type: 'meeting_markdown',
          title,
          client,
          meeting_date: date,
          uploaded_by: resolvedUploader,
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
          uploaded_by: resolvedUploader,
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

      return textResponse(`Saved meeting markdown to ${markdownPath}\nSaved meeting knowledge record to ${knowledgePath}\nUploader: ${resolvedUploader}`);
    },
  );

  server.registerTool(
    'ingest_folder',
    {
      title: 'Ingest Folder',
      description:
        'Ingest an entire folder of meetings, briefs, decks, transcripts, or notes for a client. Text files are copied into the brain; binary files (PDF, DOCX, PPTX, images, audio) are normalized to Markdown with MarkItDown inside the container.',
      inputSchema: {
        sourceFolder: z.string().min(1).describe('Absolute or project-relative path to the folder to ingest.'),
        client: z.string().optional().describe('Client or startup name this folder belongs to.'),
        uploadedBy: z.string().optional().describe('Person uploading the folder.'),
        notes: z.string().optional().describe('Optional context about this folder.'),
      },
    },
    async ({ sourceFolder, client, uploadedBy, notes }, extra) => {
      try {
        const resolvedUploader = uploadedBy || resolveUser(extra);
        const result = await ingestFolder({ sourceFolder, client, uploadedBy: resolvedUploader, notes });
        const summary = [
          `Ingested ${result.fileCount} files from ${result.sourceFolder}.`,
          `Text files: ${result.textFiles.length}.`,
          `Binary files: ${result.binaryFiles.length} (converted with MarkItDown).`,
          `Manifest: ${result.manifestPath}`,
          `Uploader: ${resolvedUploader}`,
        ].join('\n');
        return textResponse(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResponse(`Failed to ingest folder ${sourceFolder}: ${message}`);
      }
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
    async ({ question, client, tags, limit }, extra) => {
      const files = await readKnowledgeMarkdownFiles();
      const authorFilter = resolveUser(extra);
      const queryTerms = [
        ...question.split(/\s+/),
        client,
        ...tags,
        authorFilter === 'unknown' ? undefined : authorFilter,
      ]
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
        `Local placeholder search results for: ${question}`,
        client ? `(client filter: ${client})` : '',
        authorFilter !== 'unknown' ? `(author filter: ${authorFilter})` : '',
        '',
        ...matches.map((match) => `- ${match.file.path} (score: ${match.score})`),
        '',
        'TODO: replace this with a synthesized answer from the knowledge backend.',
      ]
        .filter(Boolean)
        .join('\n');

      return textResponse(answer);
    },
  );

  return server;
}

function scoreContent(content: string, queryTerms: string[]): number {
  const lowerContent = content.toLowerCase();
  return queryTerms.reduce((score, term) => score + (lowerContent.includes(term) ? 1 : 0), 0);
}

function textResponse(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export { ensureBrainFolders };