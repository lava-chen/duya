/**
 * readAllowedRoots.test.ts — T20: the read tools honour the caller's roots.
 *
 * The Coordinator reads through the same `read` / `glob` / `grep` tools
 * every session uses, so the scope has to come from the call, not from the
 * shared tool instance. These tests pin the four refusals the design asks
 * for: an absolute path outside the root, a `..` walk out of it, a symlink
 * that escapes it, and the case where no root is trusted at all.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GlobTool } from '../src/GlobTool/GlobTool.js';
import { GrepTool } from '../src/GrepTool/GrepTool.js';
import { ReadTool } from '../src/ReadTool/ReadTool.js';
import type { ToolUseContext } from '../src/contracts/tool.js';

function scoped(allowedRoots: readonly string[]): ToolUseContext {
  return { toolUseId: 'test-read-roots', options: { allowedRoots } };
}

function makeWorkspace(): { root: string; outside: string; secret: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'duya-read-roots-')));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'notes.md'), '# inside the project\n');
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'not yours\n');
  // A link inside the root that points out of it.
  symlinkSync(secret, join(root, 'escape.txt'));
  return { root, outside, secret };
}

describe('read tools honour the caller roots', () => {
  it('reads a file inside the trusted root', async () => {
    const { root } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: 'notes.md' }, root, scoped([root]));

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('inside the project');
  });

  it('refuses an absolute path outside the trusted root', async () => {
    const { root, secret } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: secret }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('refuses a relative path that walks out of the trusted root', async () => {
    const { root, outside } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: join('..', 'outside', 'secret.txt') }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('refuses a symlink that escapes the trusted root', async () => {
    const { root } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: 'escape.txt' }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('refuses every read when the caller trusts no root', async () => {
    const { root } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: 'notes.md' }, root, scoped([]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('no trusted root');
  });

  it('leaves a call without caller roots unrestricted', async () => {
    const { root } = makeWorkspace();
    const tool = new ReadTool();

    const result = await tool.execute({ file_path: 'notes.md' }, root, { toolUseId: 'no-scope' });

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('inside the project');
  });

  it('refuses a glob whose pattern walks out of the trusted root', async () => {
    const { root } = makeWorkspace();
    const tool = new GlobTool();

    const result = await tool.execute({ pattern: join('..', 'outside', '*.txt') }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('refuses a glob whose search path is outside the trusted root', async () => {
    const { root, outside } = makeWorkspace();
    const tool = new GlobTool();

    const result = await tool.execute({ pattern: '*.txt', path: outside }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('globs inside the trusted root', async () => {
    const { root } = makeWorkspace();
    const tool = new GlobTool();

    const result = await tool.execute({ pattern: '*.md' }, root, scoped([root]));

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('notes.md');
  });

  it('refuses a grep whose search path is outside the trusted root', async () => {
    const { root, outside } = makeWorkspace();
    const tool = new GrepTool();

    const result = await tool.execute({ pattern: 'not', path: outside }, root, scoped([root]));

    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('greps inside the trusted root', async () => {
    const { root } = makeWorkspace();
    const tool = new GrepTool();

    const result = await tool.execute({ pattern: 'inside' }, root, scoped([root]));

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('notes.md');
  });
});
