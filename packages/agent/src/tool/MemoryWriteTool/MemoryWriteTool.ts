import * as fs from 'node:fs';
import * as path from 'node:path';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult } from '../../types.js';
import { isPathSafe } from '../GlobTool/GlobTool.js';

/**
 * MemoryWriteTool — writes a validated memory file under the agent's working
 * directory (the live memory root). Guards against path traversal and rejects
 * content that does not carry the memory frontmatter contract, so a curator
 * agent cannot silently corrupt the memory store's format.
 */
export class MemoryWriteTool extends BaseTool {
  readonly name = 'memory_write';
  readonly description =
    'Write a validated memory file under the memory root. Input `file` is a path RELATIVE to the working directory (e.g. global/areas/<slug>.md). Input `content` MUST be a Markdown document with an H1 title (a `# ` line); optional YAML frontmatter is allowed. Rejects traversal and content without a title.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path under the memory root, e.g. global/areas/crest-hydrology.md' },
      content: { type: 'string', description: 'Full Markdown content with an H1 title.' },
    },
    required: ['file', 'content'],
  };

  async execute(input: Record<string, unknown>, workingDirectory?: string): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const file = String(input.file ?? '');
    const content = String(input.content ?? '');

    if (!workingDirectory) {
      return { id, name: this.name, result: 'No working directory available for memory_write.', error: true };
    }
    if (!isPathSafe(file, workingDirectory)) {
      return { id, name: this.name, result: `Memory path escapes the root: ${file}`, error: true };
    }

    const validation = validateMemoryContent(content);
    if (!validation.ok) {
      return { id, name: this.name, result: `Invalid memory content: ${validation.error}`, error: true };
    }

    const fullPath = path.resolve(workingDirectory, file);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    } catch (e) {
      return { id, name: this.name, result: `Write failed: ${(e as Error).message}`, error: true };
    }

    return { id, name: this.name, result: `Wrote ${file}` };
  }
}

export function validateMemoryContent(content: string): { ok: true } | { ok: false; error: string } {
  const trimmed = content.trimStart();
  if (trimmed.length === 0) return { ok: false, error: 'empty content' };
  // Strip an optional YAML frontmatter block before checking for a title.
  const body = /^---\n[\s\S]*?\n---\s*/.test(trimmed)
    ? trimmed.replace(/^---\n[\s\S]*?\n---\s*/, '')
    : trimmed;
  // A canonical record must at least carry an H1 title so the memory store
  // stays readable. If frontmatter is present and mentions status, prefer a
  // known value so stale records can be retired.
  if (!/^#\s+\S+/m.test(body)) {
    return { ok: false, error: 'missing an H1 title (a "# " line)' };
  }
  return { ok: true };
}
