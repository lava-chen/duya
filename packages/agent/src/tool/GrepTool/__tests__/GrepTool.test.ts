import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool, parseRipgrepLine } from '../GrepTool.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-grep-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-grep-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'needle in haystack\nsecond line\n');
  writeFileSync(join(outside, 'o.md'), 'needle outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('GrepTool basic', () => {
  it('finds matches inside the working directory', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });
});

describe('GrepTool allowedRoots sandbox', () => {
  it('rejects a search whose path is outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle', path: outside });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('allows a search inside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: join(root, 'memory'),
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('rejects a search that defaults to a working directory outside allowedRoots', async () => {
    const sandboxed = new GrepTool({
      workingDirectory: outside,
      allowedRoots: [join(root, 'memory')],
    });
    const result = await sandboxed.execute({ pattern: 'needle' });
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
  });

  it('behaves unchanged when allowedRoots is not set', async () => {
    const tool = new GrepTool({ workingDirectory: outside });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
  });
});

describe('GrepTool single-file search', () => {
  it('returns matches when searching a single file path (--with-filename)', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const singleFile = join(root, 'memory', 'a.md');
    const result = await tool.execute({ pattern: 'needle', path: singleFile });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.matches[0].content).toContain('needle');
    expect(parsed.matches[0].file).toBe('a.md');
  });
});

describe('GrepTool long line truncation', () => {
  it('truncates matching lines that exceed the max length', async () => {
    const longLine = 'needle ' + 'x'.repeat(5000);
    writeFileSync(join(root, 'memory', 'long.md'), longLine + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const content = parsed.matches[0].content as string;
    expect(content.length).toBeLessThan(1200);
    expect(content).toContain('line truncated');
  });
});

describe('GrepTool result limit', () => {
  it('caps results and marks truncated when max_results is exceeded', async () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(root, 'memory', 'many.md'), manyLines + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', max_results: 10 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    // total is the true count (50 lines in many.md + 1 line in a.md = 51), matches are capped at 10
    expect(parsed.total).toBe(51);
    expect(parsed.truncated).toBe(true);
    expect(parsed.matches.length).toBe(10);
  });

  it('defaults to 100 results matching the documented schema', async () => {
    const manyLines = Array.from({ length: 150 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(root, 'memory', 'many.md'), manyLines + '\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    // total is the true count (150 lines in many.md + 1 line in a.md = 151), matches are capped at 100
    expect(parsed.total).toBe(151);
    expect(parsed.truncated).toBe(true);
    expect(parsed.matches.length).toBe(100);
  });
});

describe('GrepTool relative paths', () => {
  it('returns paths relative to the search base (no drive letter)', async () => {
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const file = parsed.matches[0].file as string;
    expect(file).toBe('a.md');
    expect(file).not.toMatch(/^[A-Za-z]:/);
  });
});

describe('parseRipgrepLine (context-aware classifier)', () => {
  it('classifies a match line with a Windows drive-letter path', () => {
    const parsed = parseRipgrepLine('C:\\repo\\src\\a.ts:12:5:const needle = 1;');
    expect(parsed).toEqual({
      kind: 'match',
      file: 'C:\\repo\\src\\a.ts',
      line: 12,
      column: 5,
      content: 'const needle = 1;',
    });
  });

  it('classifies a context line (dash-delimited, no column)', () => {
    const parsed = parseRipgrepLine('C:\\repo\\src\\a.ts-10-context before');
    expect(parsed).toEqual({
      kind: 'context',
      file: 'C:\\repo\\src\\a.ts',
      line: 10,
      content: 'context before',
    });
  });

  it('classifies a context line whose content contains colons', () => {
    // Must not be mistaken for a match line: there is no `:digits:digits:`
    // anchor, so the dash-delimited form wins.
    const parsed = parseRipgrepLine('a.ts-3-line has 42: value');
    expect(parsed).toEqual({ kind: 'context', file: 'a.ts', line: 3, content: 'line has 42: value' });
  });

  it('returns null for blank lines and group separators', () => {
    expect(parseRipgrepLine('')).toBeNull();
    expect(parseRipgrepLine('   ')).toBeNull();
    expect(parseRipgrepLine('-')).toBeNull();
    expect(parseRipgrepLine('--')).toBeNull();
  });

  it('returns null for an unparseable line', () => {
    expect(parseRipgrepLine('not a ripgrep line with any structure')).toBeNull();
  });
});

describe('GrepTool context lines', () => {
  // Eagerly switch the engine the tool uses so context-window semantics are
  // tested deterministically for both engines. Searches run via the real
  // engine on the temp fixture.
  const engineProbe = GrepTool as unknown as {
    ripgrepProbe: Promise<boolean> | null;
  };
  let originalProbe: Promise<boolean> | null;
  const forceEngine = (useRipgrep: boolean): void => {
    engineProbe.ripgrepProbe = Promise.resolve(useRipgrep);
  };

  beforeEach(() => {
    originalProbe = engineProbe.ripgrepProbe;
  });

  afterEach(() => {
    engineProbe.ripgrepProbe = originalProbe;
  });

  // Node fallback walks a directory (it cannot scan a bare file path), so the
  // node tests search an isolated subdirectory containing only ctx.md.
  const nodeDir = (content: string): string => {
    const dir = join(root, 'memory', 'ctxdir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ctx.md'), content);
    return dir;
  };

  it('attaches surrounding lines to the match when context > 0 (rg engine)', async () => {
    const file = join(root, 'memory', 'ctx.md');
    writeFileSync(file, 'line one\nline two needle\nline three\nline four\n');
    forceEngine(true); // rg must be installed to reach this path.
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: file, context: 1 });
    if (result.error) throw new Error(`rg engine failed: ${result.result}`);
    const parsed = JSON.parse(result.result);
    expect(parsed.matches[0].context).toEqual([
      { line: 1, content: 'line one' },
      { line: 3, content: 'line three' },
    ]);
  });

  it('attaches surrounding lines to the match when context > 0 (node fallback)', async () => {
    const dir = nodeDir('line one\nline two needle\nline three\nline four\n');
    forceEngine(false);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: dir, context: 1 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.matches[0].context).toEqual([
      { line: 1, content: 'line one' },
      { line: 3, content: 'line three' },
    ]);
  });

  it('clamps before-context at the first line', async () => {
    const dir = nodeDir('needle first\nline two\nline three\n');
    forceEngine(false);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: dir, context: 2 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const m = parsed.matches[0];
    expect(m.line).toBe(1);
    expect(m.context.map((c: { line: number }) => c.line)).toEqual([2, 3]);
  });

  it('clamps after-context at the last line', async () => {
    const dir = nodeDir('line one\nline two\nneedle last\n');
    forceEngine(false);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: dir, context: 2 });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    const m = parsed.matches[0];
    expect(m.line).toBe(3);
    expect(m.context.map((c: { line: number }) => c.line)).toEqual([1, 2]);
  });

  it('omits the context field when context is 0', async () => {
    const dir = nodeDir('line one\nline two needle\nline three\n');
    forceEngine(false);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: dir });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    for (const m of parsed.matches) {
      expect(m).not.toHaveProperty('context');
    }
  });
});