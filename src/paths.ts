import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify, todayIsoDate } from './markdown.js';

const configuredBrainRoot = process.env.BRAIN_ROOT || 'brain';

export const projectRoot = process.cwd();
export const brainRoot = path.resolve(projectRoot, configuredBrainRoot);

export const brainFolders = {
  raw: path.join(brainRoot, 'raw'),
  markdown: path.join(brainRoot, 'markdown'),
  meetings: path.join(brainRoot, 'knowledge', 'meetings'),
  chats: path.join(brainRoot, 'knowledge', 'chats'),
  decisions: path.join(brainRoot, 'knowledge', 'decisions'),
};

export async function ensureBrainFolders(): Promise<void> {
  await Promise.all(Object.values(brainFolders).map((folder) => mkdir(folder, { recursive: true })));
}

export function buildKnowledgeFileName(title: string, date = todayIsoDate(), client?: string): string {
  const prefix = client ? `${slugify(client)}-` : '';
  return `${date}-${prefix}${slugify(title)}.md`;
}

export async function writeMarkdownFile(folder: string, fileName: string, content: string): Promise<string> {
  await ensureBrainFolders();
  const filePath = path.join(folder, fileName);
  await writeFile(filePath, content, 'utf8');
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

export async function readKnowledgeMarkdownFiles(): Promise<Array<{ path: string; content: string }>> {
  await ensureBrainFolders();
  const knowledgeRoot = path.join(brainRoot, 'knowledge');
  const files = await collectMarkdownFiles(knowledgeRoot);

  return Promise.all(
    files.map(async (filePath) => ({
      path: path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      content: await readFile(filePath, 'utf8'),
    })),
  );
}

async function collectMarkdownFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(folder, entry.name);

      if (entry.isDirectory()) {
        return collectMarkdownFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
    }),
  );

  return nested.flat();
}
