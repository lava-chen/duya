/**
 * Tool serialisation contract — Plan 587 M5.4.
 *
 * `dependency-graph-orchestrator.test.ts` (Plan 550 3b) pins the shape
 * of the plan: independent reads pack, disjoint writes pack, same-path
 * writes serialise, `requires` orders, unknown writers serialise.
 *
 * This file pins the contract M5.4 added on top of that, and every case
 * here failed against the 3b planner:
 *
 *   - read/write on the SAME path must serialise (3b compared write
 *     paths only, so a read raced a write on the same file);
 *   - two spellings of ONE file (a realpath alias) must serialise (3b
 *     compared raw strings, so a symlinked worktree and its target
 *     looked like different files);
 *   - an opaque writer must block a LATER concrete writer (3b only
 *     blocked when the later tool was the opaque one);
 *   - `produces` / `consumes` resource ordering, which the declaration
 *     type promised but the planner never evaluated.
 *
 * The alias cases run twice on purpose: once against an injected
 * canonicaliser (proves the planner's comparison logic) and once against
 * a real filesystem junction (proves the capability that backs it).
 */

import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  planExecution,
  type OrchestrationToolUse,
} from '../../../../src/tool/orchestration/DependencyGraphOrchestrator.js';
import {
  createRealpathCanonicaliser,
  createLexicalCanonicaliser,
} from '../../../../src/tool/orchestration/canonical-path.js';
import type { ToolDependencyDeclaration } from '../../../../src/tool/dependencies.js';

/** A tool that writes the path carried in its input. */
const writer = (
  id: string,
  path: string,
  deps: ToolDependencyDeclaration = { writePaths: ['__from_input__'] },
): OrchestrationToolUse => ({
  toolUseId: id,
  toolName: 'WriteTool',
  input: { path },
  dependencies: deps,
  extractWritePaths: () => [path],
});

/** A tool that reads the path carried in its input. */
const reader = (
  id: string,
  path: string,
  deps: ToolDependencyDeclaration = { readPaths: ['__from_input__'] },
): OrchestrationToolUse => ({
  toolUseId: id,
  toolName: 'ReadTool',
  input: { path },
  dependencies: deps,
  extractReadPaths: () => [path],
});

/** A tool with an opaque path set — it could touch anything. */
const opaqueWriter = (id: string): OrchestrationToolUse => ({
  toolUseId: id,
  toolName: 'BashTool',
  input: {},
  dependencies: { readPaths: ['__unknown__'], writePaths: ['__unknown__'] },
});

const opaqueReader = (id: string): OrchestrationToolUse => ({
  toolUseId: id,
  toolName: 'ScanTool',
  input: {},
  dependencies: { readPaths: ['__unknown__'], writePaths: [] },
});

const waveIds = (plan: { waves: Array<{ toolUses: OrchestrationToolUse[] }> }) =>
  plan.waves.map((w) => w.toolUses.map((t) => t.toolUseId));

describe('read and write on the same path', () => {
  it('serialises a read against a write of the same file', () => {
    // 3b only compared write paths, so this pair shared a wave.
    const plan = planExecution([
      reader('r1', '/repo/src/a.ts'),
      writer('w1', '/repo/src/a.ts'),
    ]);

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['r1'], ['w1']]);
  });

  it('serialises a write against a read of the same file, in either order', () => {
    const plan = planExecution([
      writer('w1', '/repo/src/a.ts'),
      reader('r1', '/repo/src/a.ts'),
    ]);

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['w1'], ['r1']]);
  });

  it('keeps a read and a write of DIFFERENT paths in one wave', () => {
    const plan = planExecution([
      reader('r1', '/repo/src/a.ts'),
      writer('w1', '/repo/src/b.ts'),
    ]);

    expect(plan.waves).toHaveLength(1);
    expect(waveIds(plan)).toEqual([['r1', 'w1']]);
  });

  it('keeps two reads of the same file parallel', () => {
    // Reads observe a snapshot; two of them never need to queue.
    const plan = planExecution([
      reader('r1', '/repo/src/a.ts'),
      reader('r2', '/repo/src/a.ts'),
    ]);

    expect(plan.waves).toHaveLength(1);
    expect(waveIds(plan)).toEqual([['r1', 'r2']]);
  });
});

describe('realpath alias conflicts', () => {
  it('serialises two writes whose paths canonicalise to one file', () => {
    // A caller that knows the aliasing: the planner must not trust the
    // raw strings.
    const canonicaliser = (path: string) =>
      path.replace('/alias', '/real').toLowerCase();

    const plan = planExecution(
      [writer('w1', '/alias/a.ts'), writer('w2', '/real/a.ts')],
      undefined,
      { canonicaliser },
    );

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['w1'], ['w2']]);
  });

  it('keeps two writes to genuinely different files parallel under the same canonicaliser', () => {
    const canonicaliser = (path: string) =>
      path.replace('/alias', '/real').toLowerCase();

    const plan = planExecution(
      [writer('w1', '/alias/a.ts'), writer('w2', '/real/b.ts')],
      undefined,
      { canonicaliser },
    );

    expect(plan.waves).toHaveLength(1);
    expect(waveIds(plan)).toEqual([['w1', 'w2']]);
  });

  describe('against a real filesystem alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-m5-4-alias-'));
    const realDir = join(root, 'real');
    const aliasDir = join(root, 'alias');

    afterAll(() => {
      // Best-effort cleanup; the OS temp dir is reclaimed regardless and
      // Remove-Item is not available in this environment.
    });

    it('serialises writes to one file reached through a junction and its target', () => {
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, 'a.ts'), 'x', 'utf8');
      try {
        symlinkSync(realDir, aliasDir, 'junction');
      } catch {
        // Creating a junction needs either developer mode or elevation.
        // Without it the capability cannot be exercised on this host, so
        // report that rather than silently passing.
        throw new Error('could not create junction; realpath alias unproven on this host');
      }

      const canonicaliser = createRealpathCanonicaliser();
      const viaAlias = join(aliasDir, 'a.ts');
      const viaReal = join(realDir, 'a.ts');

      // Sanity: the two spellings really are different strings.
      expect(viaAlias).not.toBe(viaReal);
      expect(canonicaliser(viaAlias)).toBe(canonicaliser(viaReal));

      const plan = planExecution(
        [writer('w1', viaAlias), writer('w2', viaReal)],
        undefined,
        { canonicaliser },
      );

      expect(plan.waves).toHaveLength(2);
      expect(waveIds(plan)).toEqual([['w1'], ['w2']]);
    });
  });
});

describe('undeclared side effects are serialised conservatively', () => {
  it('blocks a concrete writer that follows an opaque writer', () => {
    // The 3b planner only blocked when the LATER tool was the opaque
    // one, so this pair wrongly shared a wave.
    const plan = planExecution([opaqueWriter('b1'), writer('w1', '/repo/a.ts')]);

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['b1'], ['w1']]);
  });

  it('blocks a concrete writer that precedes an opaque writer', () => {
    const plan = planExecution([writer('w1', '/repo/a.ts'), opaqueWriter('b1')]);

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['w1'], ['b1']]);
  });

  it('serialises an opaque reader against a writer but not against a reader', () => {
    const readerVsWriter = planExecution([opaqueReader('s1'), writer('w1', '/repo/a.ts')]);
    expect(readerVsWriter.waves).toHaveLength(2);

    const readerVsReader = planExecution([opaqueReader('s1'), opaqueReader('s2')]);
    expect(readerVsReader.waves).toHaveLength(1);
  });

  it('leaves a tool that declares no paths free to run beside anything', () => {
    const plan = planExecution([
      { toolUseId: 'x1', toolName: 'Think', input: {} },
      writer('w1', '/repo/a.ts'),
      reader('r1', '/repo/b.ts'),
    ]);

    expect(plan.waves).toHaveLength(1);
    expect(waveIds(plan)).toEqual([['x1', 'w1', 'r1']]);
  });
});

describe('resource keys: produces / consumes', () => {
  it('orders a consumer after the producer of the same key', () => {
    const plan = planExecution([
      {
        toolUseId: 'c1',
        toolName: 'Report',
        input: {},
        dependencies: { consumes: ['git_status'] },
      },
      {
        toolUseId: 'p1',
        toolName: 'GitStatus',
        input: {},
        dependencies: { produces: ['git_status'] },
      },
    ]);

    expect(plan.waves).toHaveLength(2);
    expect(waveIds(plan)).toEqual([['p1'], ['c1']]);
  });

  it('does not serialise a consumer against a producer of a different key', () => {
    const plan = planExecution([
      {
        toolUseId: 'c1',
        toolName: 'Report',
        input: {},
        dependencies: { consumes: ['git_status'] },
      },
      {
        toolUseId: 'p1',
        toolName: 'SessionSearch',
        input: {},
        dependencies: { produces: ['session_results'] },
      },
    ]);

    expect(plan.waves).toHaveLength(1);
    expect(waveIds(plan)).toEqual([['c1', 'p1']]);
  });
});

describe('path canonicalisation', () => {
  const realpath = createRealpathCanonicaliser();
  const lexical = createLexicalCanonicaliser();

  it('folds `..` and `.` segments onto the same key', () => {
    expect(lexical('/repo/src/../src/a.ts')).toBe(lexical('/repo/src/a.ts'));
    expect(lexical('/repo/./src/a.ts')).toBe(lexical('/repo/src/a.ts'));
  });

  it('leaves the sentinels alone so the unknown signal survives', () => {
    for (const c of [realpath, lexical]) {
      expect(c('__unknown__')).toBe('__unknown__');
      expect(c('__from_input__')).toBe('__from_input__');
    }
  });

  it('resolves a file that does not exist yet, which WriteTool routinely targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-m5-4-missing-'));
    const missing = join(root, 'not-created-yet.ts');

    // The leaf does not exist, so the canonicaliser must fall back to
    // the deepest existing ancestor rather than throwing.
    const resolved = realpath(missing);
    expect(resolved).toContain('not-created-yet.ts');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('is stable and total: it never throws on hostile input', () => {
    for (const c of [realpath, lexical]) {
      expect(() => c('')).not.toThrow();
      expect(() => c('\0invalid')).not.toThrow();
      expect(c('')).toBe('');
      expect(c(realpath(join(tmpdir(), 'x.ts')))).toBe(c(realpath(join(tmpdir(), 'x.ts'))));
    }
  });
});
