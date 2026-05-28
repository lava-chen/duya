import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type {
  PluginMarkdownParseResult,
  PluginMarkdownFrontmatter,
} from './types.js';

function extractFrontmatter(content: string): {
  yaml: string;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { yaml: '', body: content };
  }

  const endDelimIdx = trimmed.indexOf('\n---', 3);
  if (endDelimIdx === -1) {
    const closingIdx = trimmed.indexOf('---', 3);
    if (closingIdx === -1) {
      return { yaml: '', body: content };
    }
    const yaml = trimmed.slice(3, closingIdx).trim();
    const body = trimmed.slice(closingIdx + 3).trim();
    return { yaml, body };
  }

  const yaml = trimmed.slice(3, endDelimIdx).trim();
  const body = trimmed.slice(endDelimIdx + 4).trim();
  return { yaml, body };
}

function parseAuthor(raw: unknown): { name: string; url?: string } | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    return { name: raw };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name === 'string') {
      return {
        name: obj.name,
        url: typeof obj.url === 'string' ? obj.url : undefined,
      };
    }
  }
  return undefined;
}

export function parsePluginMarkdown(filePath: string): PluginMarkdownParseResult {
  if (!existsSync(filePath)) {
    return { frontmatter: null, body: '', rawFrontmatter: {} };
  }

  const content = readFileSync(filePath, 'utf-8');
  return parsePluginMarkdownContent(content, filePath);
}

export function parsePluginMarkdownContent(
  content: string,
  sourcePath?: string
): PluginMarkdownParseResult {
  const { yaml, body } = extractFrontmatter(content);

  let rawFrontmatter: Record<string, unknown> = {};
  if (yaml) {
    try {
      const parsed = parseYaml(yaml);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawFrontmatter = parsed as Record<string, unknown>;
      }
    } catch {
    }
  }

  if (Object.keys(rawFrontmatter).length === 0) {
    return {
      frontmatter: null,
      body,
      rawFrontmatter: {},
    };
  }

  const frontmatter: PluginMarkdownFrontmatter = {
    name: typeof rawFrontmatter.name === 'string'
      ? rawFrontmatter.name
      : sourcePath ?? 'unknown',
    description: typeof rawFrontmatter.description === 'string'
      ? rawFrontmatter.description
      : '',
  };

  if (typeof rawFrontmatter.version === 'string') {
    frontmatter.version = rawFrontmatter.version;
  }

  const author = parseAuthor(rawFrontmatter.author);
  if (author) {
    frontmatter.author = author;
  }

  for (const kind of ['commands', 'skills', 'agents'] as const) {
    const items = rawFrontmatter[kind];
    if (Array.isArray(items)) {
      const parsed = items
        .map((item: unknown, i: number) => {
          if (typeof item === 'object' && item !== null) {
            const obj = item as Record<string, unknown>;
            const name = typeof obj.name === 'string' ? obj.name : null;
            const file = typeof obj.file === 'string' ? obj.file : null;
            const description = typeof obj.description === 'string' ? obj.description : undefined;
            if (name) {
              return {
                name,
                file: file ?? `${kind}/${name}.md`,
                description,
              };
            }
          }
          return null;
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      if (parsed.length > 0) {
        frontmatter[kind] = parsed;
      }
    }
  }

  if (Array.isArray(rawFrontmatter.hooks)) {
    const hooks = rawFrontmatter.hooks
      .map((item: unknown) => {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const event = typeof obj.event === 'string' ? obj.event : null;
          const handler = typeof obj.handler === 'string' ? obj.handler : null;
          if (event && handler) {
            return { event, handler };
          }
        }
        return null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (hooks.length > 0) {
      frontmatter.hooks = hooks;
    }
  }

  if (typeof rawFrontmatter.agent_context === 'string') {
    frontmatter.agent_context = rawFrontmatter.agent_context;
  }

  return {
    frontmatter,
    body,
    rawFrontmatter,
  };
}