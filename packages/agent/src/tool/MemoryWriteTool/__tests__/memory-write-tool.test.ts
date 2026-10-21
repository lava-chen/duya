import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryWriteTool } from '../MemoryWriteTool.js';

function makeValidFrontmatter(): string {
  return [
    '---',
    'memory_id: mem_test',
    'canonical_key: preference:verification-style',
    'claim_type: preference',
    'scope: personal',
    'scope_id: null',
    'project_id: null',
    'status: active',
    'importance: normal',
    'summary_eligible: true',
    'valid_from: 2026-08-09',
    'updated_at: 2026-08-09T12:00:00Z',
    '---',
    '',
    '# Body',
    'Some content.',
  ].join('\n');
}

describe('MemoryWriteTool', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('writes a valid file under the working directory', async () => {
    const tool = new MemoryWriteTool();
    const res = await tool.execute(
      { file: 'items/preference/verification-style.md', content: makeValidFrontmatter() },
      root,
    );
    expect(res.error).toBeFalsy();
    const full = path.join(root, 'items/preference/verification-style.md');
    expect(fs.existsSync(full)).toBe(true);
    expect(fs.readFileSync(full, 'utf8')).toContain('canonical_key: preference:verification-style');
  });

  it('rejects a path that escapes the working directory', async () => {
    const tool = new MemoryWriteTool();
    const res = await tool.execute(
      { file: '../../outside.md', content: makeValidFrontmatter() },
      root,
    );
    expect(res.error).toBe(true);
  });

  it('rejects content without an H1 title', async () => {
    const tool = new MemoryWriteTool();
    const res = await tool.execute(
      { file: 'global/areas/x.md', content: 'no title, just a paragraph of body text' },
      root,
    );
    expect(res.error).toBe(true);
  });

  it('accepts a plain-markdown record with an H1 title and no frontmatter', async () => {
    const tool = new MemoryWriteTool();
    const res = await tool.execute(
      { file: 'global/areas/x.md', content: '# My Area\n\n## Summary\nSome durable knowledge.' },
      root,
    );
    expect(res.error).toBeFalsy();
    const full = path.join(root, 'global/areas/x.md');
    expect(fs.existsSync(full)).toBe(true);
  });
});
