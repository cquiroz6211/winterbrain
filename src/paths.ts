import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildMarkdownDocument, slugify, todayIsoDate } from './markdown.js';

const execFileAsync = promisify(execFile);

const configuredMarkitdownCommand = process.env.MARKITDOWN_COMMAND || 'markitdown';

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

export const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.log',
  '.html',
  '.htm',
  '.xml',
]);

export const BINARY_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.rtf',
  '.epub',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.tiff',
  '.bmp',
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac',
  '.mp4',
  '.mov',
  '.mkv',
]);

export interface IngestedFile {
  source: string;
  rawPath: string;
  category: 'text' | 'binary';
  bytes: number;
}

export interface ConvertedFile extends IngestedFile {
  markdownPath: string;
}

export interface ConversionError {
  source: string;
  rawPath: string;
  error: string;
}

export interface IngestFolderResult {
  sourceFolder: string;
  fileCount: number;
  textFiles: IngestedFile[];
  binaryFiles: IngestedFile[];
  manifestPath: string;
}

function resolveSourceFolder(input: string): string {
  if (path.isAbsolute(input)) {
    return path.resolve(input);
  }
  return path.resolve(projectRoot, input);
}

function fileCategory(filePath: string): 'text' | 'binary' | 'unsupported' {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return 'unsupported';
}

export async function ingestFolder(options: {
  sourceFolder: string;
  client?: string;
  uploadedBy?: string;
  notes?: string;
}): Promise<IngestFolderResult> {
  const source = resolveSourceFolder(options.sourceFolder);
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${source}`);
  }

  await ensureBrainFolders();
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const rawSubdir = path.join(brainFolders.raw, `${stamp}-${slugify(options.client || path.basename(source))}`);
  const markdownSubdir = path.join(brainFolders.markdown, `${stamp}-${slugify(options.client || path.basename(source))}`);

  const allFiles = await collectAllFiles(source);
  const textFiles: IngestedFile[] = [];
  const binaryFiles: IngestedFile[] = [];
  const convertedFiles: ConvertedFile[] = [];
  const conversionErrors: ConversionError[] = [];
  const skipped: string[] = [];

  for (const relativeFile of allFiles) {
    const absoluteFile = path.join(source, relativeFile);
    const category = fileCategory(absoluteFile);
    if (category === 'unsupported') {
      skipped.push(relativeFile);
      continue;
    }

    const destinationRelative = relativeFile.replace(/[\\/]/g, '__');
    const destinationPath = path.join(rawSubdir, destinationRelative);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const data = await readFile(absoluteFile);
    await writeFile(destinationPath, data);

    const record: IngestedFile = {
      source: relativeFile,
      rawPath: path.relative(projectRoot, destinationPath).replace(/\\/g, '/'),
      category,
      bytes: data.byteLength,
    };

    if (category === 'text') {
      textFiles.push(record);
      continue;
    }

    binaryFiles.push(record);

    try {
      const markdown = await runMarkitdownBinary(absoluteFile);
      const markdownRelative = `${destinationRelative}.md`;
      const markdownPath = path.join(markdownSubdir, markdownRelative);
      await mkdir(path.dirname(markdownPath), { recursive: true });
      const frontmatter = [
        '---',
        `source_file: ${JSON.stringify(relativeFile)}`,
        `original_format: ${JSON.stringify(path.extname(absoluteFile).slice(1).toLowerCase())}`,
        `client: ${JSON.stringify(options.client || '')}`,
        `uploaded_by: ${JSON.stringify(options.uploadedBy || '')}`,
        `ingested_at: ${JSON.stringify(new Date().toISOString())}`,
        'converter: markitdown',
        '---',
        '',
      ].join('\n');
      await writeFile(markdownPath, frontmatter + markdown, 'utf8');
      convertedFiles.push({
        source: relativeFile,
        rawPath: record.rawPath,
        category: 'binary',
        markdownPath: path.relative(projectRoot, markdownPath).replace(/\\/g, '/'),
        bytes: data.byteLength,
      });
    } catch (error) {
      conversionErrors.push({
        source: relativeFile,
        rawPath: record.rawPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const manifestName = `${now.toISOString().slice(0, 10)}-${slugify(options.client || path.basename(source))}-folder-ingest.md`;
  const manifestBody = buildFolderManifest({
    source,
    client: options.client,
    uploadedBy: options.uploadedBy,
    notes: options.notes,
    stamp,
    rawSubdir: path.relative(projectRoot, rawSubdir).replace(/\\/g, '/'),
    markdownSubdir: path.relative(projectRoot, markdownSubdir).replace(/\\/g, '/'),
    textFiles,
    binaryFiles,
    convertedFiles,
    conversionErrors,
    skipped,
  });

  const manifestPath = await writeMarkdownFile(brainFolders.decisions, manifestName, manifestBody);

  return {
    sourceFolder: source,
    fileCount: textFiles.length + binaryFiles.length,
    textFiles,
    binaryFiles,
    manifestPath,
  };
}

function buildFolderManifest(options: {
  source: string;
  client?: string;
  uploadedBy?: string;
  notes?: string;
  stamp: string;
  rawSubdir: string;
  markdownSubdir: string;
  textFiles: IngestedFile[];
  binaryFiles: IngestedFile[];
  convertedFiles: ConvertedFile[];
  conversionErrors: ConversionError[];
  skipped: string[];
}): string {
  const fileLine = (file: IngestedFile): string =>
    `- \`${file.source}\` -> \`${file.rawPath}\` (${file.bytes} bytes)`;
  const convertedLine = (file: ConvertedFile): string =>
    `- \`${file.source}\` -> \`${file.markdownPath}\` (${file.bytes} bytes)`;

  const sections = [
    {
      heading: 'Source',
      body: options.source,
    },
    {
      heading: 'Notes',
      body: options.notes || '_No extra notes provided._',
    },
    {
      heading: 'Ingested Text Files',
      body: options.textFiles.length
        ? options.textFiles.map(fileLine)
        : '_No text files ingested._',
    },
    {
      heading: 'Binary Files Converted with MarkItDown',
      body: options.convertedFiles.length
        ? options.convertedFiles.map(convertedLine)
        : '_No binary files converted yet._',
    },
    {
      heading: 'Conversion Errors',
      body: options.conversionErrors.length
        ? options.conversionErrors.map((err) => `- \`${err.source}\`: ${err.error}`)
        : '_None._',
    },
    {
      heading: 'Skipped Files',
      body: options.skipped.length
        ? options.skipped.map((name) => `- \`${name}\``)
        : '_None._',
    },
    {
      heading: 'Next Steps',
      body: [
        'Run the LLM extractor over each file in `brain/markdown/` to emit structured notes.',
        'Wire embeddings / GBrain once the company brain backend is selected (Fase 5 del ROADMAP).',
      ],
    },
  ];

  return buildMarkdownDocument({
    title: `Folder Ingest — ${options.client || path.basename(options.source)}`,
    frontmatter: {
      type: 'folder_ingest',
      title: `Folder Ingest ${options.client || path.basename(options.source)}`,
      client: options.client,
      uploaded_by: options.uploadedBy,
      source_folder: options.source,
      raw_subdir: options.rawSubdir,
      markdown_subdir: options.markdownSubdir,
      text_files: options.textFiles.length,
      binary_files: options.binaryFiles.length,
      converted_files: options.convertedFiles.length,
      conversion_errors: options.conversionErrors.length,
      skipped_files: options.skipped.length,
      ingested_at: new Date().toISOString(),
    },
    sections,
  });
}

async function collectAllFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(folder, entry.name);
      const relative = entry.name;

      if (entry.isDirectory()) {
        const inner = await collectAllFiles(entryPath);
        return inner.map((child) => path.join(relative, child));
      }

      return entry.isFile() ? [relative] : [];
    }),
  );

  return nested.flat();
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

async function runMarkitdownBinary(inputPath: string): Promise<string> {
  const [command, ...prefixArgs] = configuredMarkitdownCommand.split(/\s+/);
  const { stdout } = await execFileAsync(command, [...prefixArgs, inputPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}
