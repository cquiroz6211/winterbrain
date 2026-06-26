export type FrontmatterValue = string | string[] | number | boolean | null | undefined;

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toFrontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`);

  return `---\n${lines.join('\n')}\n---`;
}

export function buildMarkdownDocument(options: {
  title: string;
  frontmatter: Record<string, FrontmatterValue>;
  sections: Array<{ heading: string; body: string | string[] }>;
}): string {
  const sections = options.sections
    .map((section) => {
      const body = Array.isArray(section.body)
        ? section.body.map((item) => `- ${item}`).join('\n')
        : section.body;

      return `## ${section.heading}\n\n${body.trim() || '_Not provided._'}`;
    })
    .join('\n\n');

  return `${toFrontmatter(options.frontmatter)}\n\n# ${options.title}\n\n${sections}\n`;
}

function formatFrontmatterValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  return String(value);
}
