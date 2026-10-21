import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { GrepTool, parseRipgrepLine } from '../GrepTool.js';
import { windowsPathToPosixPath } from '../../../utils/windowsPaths.js';

let root: string;
let outside: string;

/**
 * GrepTool selects its engine from a cached `rg --version` probe, so a test
 * that does not pin the engine asserts whatever the host happens to have
 * installed — which is why this suite's failure count moved between machines
 * and between runs. Every case below therefore runs against the Node fallback
 * (always available) unless it deliberately opts into the rg engine, and the
 * one test that genuinely needs ripgrep probes for it first instead of
 * forcing a branch that cannot execute.
 */
const engineProbe = GrepTool as unknown as {
  ripgrepProbe: Promise<boolean> | null;
};
let savedProbe: Promise<boolean> | null = null;

function forceEngine(useRipgrep: boolean): void {
  engineProbe.ripgrepProbe = Promise.resolve(useRipgrep);
}

/** Real probe, used where the test must know whether ripgrep can run. */
function ripgrepOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('rg', ['--version'], (err) => resolve(!err));
  });
}

beforeEach(() => {
  savedProbe = engineProbe.ripgrepProbe;
  forceEngine(false);
  root = mkdtempSync(join(tmpdir(), 'duya-grep-roots-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-grep-out-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'a.md'), 'needle in haystack\nsecond line\n');
  writeFileSync(join(outside, 'o.md'), 'needle outside\n');
});

afterEach(() => {
  engineProbe.ripgrepProbe = savedProbe;
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
    // Locate the long file's match by name. `matches[0]` was engine- and
    // filesystem-order dependent: readdir order does not have to agree with
    // ripgrep's walk order, so the assertion was really testing enumeration
    // order rather than truncation.
    const long = parsed.matches.find((m: { file: string }) => m.file === 'long.md');
    expect(long).toBeDefined();
    const content = long.content as string;
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

describe('GrepTool missing search path', () => {
  it('fails loudly instead of reporting a clean "No matches found"', async () => {
    const tool = new GrepTool({ workingDirectory: root });
    const result = await tool.execute({ pattern: 'needle', path: join(root, 'does-not-exist') });
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not exist');
    expect(parsed.error).toContain('does-not-exist');
  });
});

describe.skipIf(process.platform !== 'win32')('GrepTool POSIX-shell paths (win32)', () => {
  it('accepts a Git Bash style path (/e/...) and finds matches', async () => {
    const msys = windowsPathToPosixPath(join(root, 'memory'));
    expect(msys).toMatch(/^\/[a-z]\//);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: msys });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('accepts a WSL style path (/mnt/e/...) and finds matches', async () => {
    const wsl = '/mnt' + windowsPathToPosixPath(join(root, 'memory'));
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: wsl });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.total).toBeGreaterThan(0);
  });
});

describe('GrepTool Node fallback time budget', () => {
  // The file-level beforeEach already pins the Node engine, so the budget
  // path is exercised deterministically regardless of whether ripgrep is
  // installed.

  it('marks results incomplete with a warning when the budget is exhausted', async () => {
    // Same reasoning as the empty-search case below: 1 ms is the smallest
    // budget the constructor accepts, and a two-file walk can finish inside
    // it. Pad the fixture so crossing the deadline is certain rather than a
    // race against host speed.
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(root, 'memory', `pad-${i}.md`), 'nothing relevant on this line\n');
    }
    const tool = new GrepTool({
      workingDirectory: join(root, 'memory'),
      nodeFallbackTimeBudgetMs: 1,
    });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.truncated).toBe(true);
    expect(parsed.warning).toContain('time budget');
  });

  it('reports a warned empty search as incomplete, not as "No matches found"', async () => {
    // 1 ms is the smallest budget the constructor accepts, and a two-file
    // walk can finish inside it on a warm cache — so this assertion used to
    // race the machine and pass or fail depending on how fast the host was.
    // Seed enough files that the walk provably crosses the deadline.
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(root, 'memory', `pad-${i}.md`), 'nothing relevant on this line\n');
    }
    const tool = new GrepTool({
      workingDirectory: join(root, 'memory'),
      nodeFallbackTimeBudgetMs: 1,
    });
    const result = await tool.execute({ pattern: 'needle-never-matches-any-fixture-line' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.matches).toEqual([]);
    expect(parsed.warning).toContain('time budget');
    expect(parsed.message).not.toBe('No matches found');
  });

  it('returns a clean empty result when the budget is not exhausted', async () => {
    const tool = new GrepTool({
      workingDirectory: join(root, 'memory'),
      nodeFallbackTimeBudgetMs: 30_000,
    });
    const result = await tool.execute({ pattern: 'needle-never-matches-any-fixture-line' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.matches).toEqual([]);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.message).toBe('No matches found');
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
  // Both engines must produce the same context contract, so the assertions
  // below are identical for each. The forced-node case always runs; the rg
  // case probes for a real ripgrep instead of forcing a branch the host may
  // not be able to execute.

  const nodeDir = (content: string): string => {
    const dir = join(root, 'memory', 'ctxdir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ctx.md'), content);
    return dir;
  };

  it('attaches surrounding lines to the match when context > 0 (rg engine when the host has ripgrep)', async () => {
    const file = join(root, 'memory', 'ctx.md');
    writeFileSync(file, 'line one\nline two needle\nline three\nline four\n');
    // Probe for real rather than forcing `true`. The previous version forced
    // the rg engine unconditionally, so on a runner without ripgrep it only
    // ever exercised `spawn rg ENOENT` and reported a misleading failure.
    // When ripgrep is present this drives the real rg engine; when it is not,
    // the file-level default keeps the Node engine selected. Either way the
    // contract under test — the attached context lines — is asserted in full.
    const hasRipgrep = await ripgrepOnPath();
    if (hasRipgrep) forceEngine(true);
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const result = await tool.execute({ pattern: 'needle', path: file, context: 1 });
    if (result.error) throw new Error(`context search failed: ${result.result}`);
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