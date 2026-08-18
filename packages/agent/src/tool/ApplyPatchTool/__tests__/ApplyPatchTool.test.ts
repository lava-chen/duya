import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyPatchTool, parseCodexPatch, applyHunkToLines } from '../ApplyPatchTool.js';
import type { ToolUseContext } from '../../../types.js';
import type { ToolPermissionContext } from '../../../permissions/types.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-patch-'));
  outside = mkdtempSync(join(tmpdir(), 'duya-patch-out-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\nconst z = 4;\n');
  writeFileSync(join(outside, 'o.ts'), 'outside\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('parseCodexPatch', () => {
  it('parses add/update/delete operations', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const a = 1;
+export const b = 2;
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** Delete File: src/old.ts
*** End Patch`;
    const ops = parseCodexPatch(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ kind: 'add', path: 'src/new.ts' });
    expect(ops[0].content).toBe('export const a = 1;\nexport const b = 2;');
    expect(ops[1]).toMatchObject({ kind: 'update', path: 'src/a.ts' });
    expect(ops[1].hunks).toHaveLength(1);
    expect(ops[2]).toMatchObject({ kind: 'delete', path: 'src/old.ts' });
  });

  it('throws when no Begin Patch marker found', () => {
    expect(() => parseCodexPatch('no marker here')).toThrow('Begin Patch');
  });

  it('does not throw when an @@ hunk follows a *** Add File header', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
@@
+export const a = 1;
+export const b = 2;
*** End Patch`;
    const ops = parseCodexPatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'add', path: 'src/new.ts' });
    // The `+` lines in the unified-diff hunk become the new file's content.
    expect(ops[0].content).toBe('export const a = 1;\nexport const b = 2;');
  });

  it('throws on empty operations', () => {
    expect(() => parseCodexPatch('*** Begin Patch\n*** End Patch')).toThrow('no file operations');
  });
});

describe('applyHunkToLines', () => {
  it('replaces a removed line with an added line', () => {
    const lines = ['a', 'b', 'c'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(true);
    expect(result.lines).toEqual(['a', 'B', 'c']);
  });

  it('tolerates trailing-whitespace drift on the file', () => {
    const lines = ['a', 'b   ', 'c'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(true);
    expect(result.lines).toEqual(['a', 'B', 'c']);
  });

  it('returns failure when context does not match', () => {
    const lines = ['x', 'y', 'z'];
    const hunk = { lines: [' a', '-b', '+B', ' c'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(false);
  });

  it('returns failure when ambiguous (multiple matches)', () => {
    const lines = ['b', 'b'];
    const hunk = { lines: ['-b', '+B'] };
    const result = applyHunkToLines(lines, hunk);
    expect(result.success).toBe(false);
  });

  it('marks ambiguous matches with candidate locations', () => {
    const result = applyHunkToLines(['b', 'b', 'b'], { lines: ['-b', '+B'] });
    if (result.success) throw new Error('expected an ambiguous failure');
    expect(result.ambiguous).toBe(true);
    expect(result.candidateStarts).toEqual([0, 1, 2]);
  });

  it('points actualContextStart at the closest window on zero match (not file head)', () => {
    // Codex-style hunk (context lines have a leading space). The target block
    // is absent, but the file has a similar section later — the diagnostic
    // should point there, not at the file head.
    const lines = ['[package]', 'name = "a"', '', '[dependencies]', 'foo = "1"', 'bar = "2"'];
    const hunk = {
      lines: [' [dependencies.target]', ' foo = "1"', '-bar = "3"', '+bar = "9"'],
    };
    const result = applyHunkToLines(lines, hunk);
    if (result.success) throw new Error('expected a zero-match failure');
    expect(result.ambiguous).toBeFalsy();
    // Closest window (the [dependencies] block) starts at line 3, not line 0.
    expect(result.actualContextStart).toBeGreaterThan(0);
  });

  it('falls back to file head when the needle cannot fit in the file', () => {
    const result = applyHunkToLines(['a'], { lines: ['-a', '-b', '+c'] });
    if (result.success) throw new Error('expected a failure');
    expect(result.actualContextStart).toBe(0);
  });
});

describe('ApplyPatchTool execute', () => {
  it('updates a single file', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
  });

  it('adds a new file', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const a = 1;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf-8')).toContain('export const a = 1;');
  });

  it('applies an add-file whose content is a trailing @@ hunk', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Add File: src/new.ts
@@
+export const a = 1;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf-8')).toContain('export const a = 1;');
  });

  it('reports an ambiguous hunk with a non-contradictory message', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'dup.ts'), 'a\nb\nb\nb\n');
    const patch = `*** Begin Patch
*** Update File: src/dup.ts
@@
-b
+B
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('ambiguous');
    expect(result.result).toContain('Add more surrounding context');
    expect(result.result).toContain('so the match is unique');
    expect(result.result).toContain('Candidate match locations (1-based line numbers): 2, 3, 4');
    // Ambiguity is not a "not found" case, so never claim the lines are missing.
    expect(result.result).not.toContain('Failed to find');
    // The file is left unchanged when the match is ambiguous.
    expect(readFileSync(join(root, 'src', 'dup.ts'), 'utf-8')).toBe('a\nb\nb\nb\n');
  });

  it('deletes a file', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'old.ts'), 'old\n');
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(existsSync(join(root, 'src', 'old.ts'))).toBe(false);
  });

  it('applies multiple files in one call', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'b.ts'), 'const p = 1;\nconst q = 2;\n');
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** Update File: src/b.ts
@@
 const p = 1;
-const q = 2;
+const q = 9;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf-8')).toContain('const q = 9;');
  });

  it('handles CRLF files', async () => {
    const tool = new ApplyPatchTool();
    writeFileSync(join(root, 'src', 'crlf.ts'), 'a\r\nb\r\nc\r\n');
    const patch = `*** Begin Patch
*** Update File: src/crlf.ts
@@
 a
-b
+B
 c
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBeFalsy();
    expect(readFileSync(join(root, 'src', 'crlf.ts'), 'utf-8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('rejects a path outside allowedRoots', async () => {
    const tool = new ApplyPatchTool({ allowedRoots: [join(root, 'src')] });
    const patch = `*** Begin Patch
*** Update File: ${join(outside, 'o.ts')}
@@
-outside
+INSIDE
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('outside the allowed roots');
    expect(readFileSync(join(outside, 'o.ts'), 'utf-8')).toBe('outside\n');
  });

  it('reports a failed hunk as a partial failure', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 does not exist anywhere
-const y = 2;
+const y = 3;
*** End Patch`;
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    // Verification read-back reports the failed hunk with the real context
    // lines so the model can fix the hunk in place.
    expect(result.result).toContain('Failed to find expected lines in src/a.ts');
    expect(result.result).toContain('Actual lines near the failure');
    // Content unchanged
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 2;');
  });
});

describe('ApplyPatchTool write permission gating', () => {
  // Catastrophic Windows prefix; isCatastrophicPath matches it on every
  // platform, mirroring permissions.test.ts usage of the same prefix.
  const deniedPath = 'C:\\Windows\\System32\\duya-apply-patch-test.ini';

  function makePermissionContext(mode: ToolPermissionContext['mode']): ToolPermissionContext {
    return {
      mode,
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    };
  }

  function makeToolUseContext(permissionContext?: ToolPermissionContext): ToolUseContext {
    let appState: Record<string, unknown> = permissionContext
      ? { toolPermissionContext: permissionContext }
      : {};
    return {
      toolUseId: 'ctx-apply-patch-perm',
      abortController: new AbortController(),
      getAppState: () => appState,
      setAppState: (updater) => {
        appState = typeof updater === 'function' ? updater(appState) : updater;
      },
      options: {
        tools: [],
        commands: [],
        mainLoopModel: 'test-model',
        mcpClients: [],
        workingDirectory: root,
      },
    };
  }

  it('routes a write-denied op into failures while other ops still apply', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: ${deniedPath}
@@
-anything
+malicious
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** End Patch`;
    const result = await tool.execute({ patch }, root, makeToolUseContext(makePermissionContext('default')));
    // Partial failure semantics: one op applied, so error stays false.
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('Permission denied');
    expect(result.result).toContain(deniedPath);
    // The allowed op was still applied.
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
  });

  it('returns error:true when every op is denied by write permission', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Add File: ${deniedPath}
+should never be written
*** End Patch`;
    const result = await tool.execute({ patch }, root, makeToolUseContext(makePermissionContext('default')));
    expect(result.error).toBe(true);
    expect(result.result).toContain('Permission denied');
    expect(result.result).not.toContain('Applied 1');
  });

  it('applies normally when write permission allows the paths', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
*** End Patch`;
    const result = await tool.execute({ patch }, root, makeToolUseContext(makePermissionContext('default')));
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('Applied 1 operation(s)');
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf-8')).toContain('const y = 3;');
  });

  it('denies catastrophic paths even without a ToolUseContext', async () => {
    const tool = new ApplyPatchTool();
    const patch = `*** Begin Patch
*** Add File: ${deniedPath}
+should never be written
*** End Patch`;
    // Defensive depth: execute() re-checks write permission even when the
    // caller passes no context, so catastrophic paths stay blocked.
    const result = await tool.execute({ patch }, root);
    expect(result.error).toBe(true);
    expect(result.result).toContain('Permission denied');
  });
});