/**
 * DependencyGraphOrchestrator unit tests — Plan 550 step 3b.
 *
 * Lock the scheduling contract the future StreamingToolExecutor (3c)
 * will rely on. Each scenario targets a specific planning rule:
 *
 *   - All independent reads land in one wave (parallel-friendly).
 *   - Two writes to disjoint paths land in one wave.
 *   - Two writes to the same path serialise across waves.
 *   - `requires: ['X']` forces a dependency ordering.
 *   - UNKNOWN_PATHS writers serialise against every other writer.
 *   - Cycles / unmet prerequisites surface as `unresolved`.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import {
  planExecution,
  DEFAULT_MAX_CONCURRENCY,
  type OrchestrationToolUse,
} from '../../../../src/tool/orchestration/DependencyGraphOrchestrator.js';
import type { ToolDependencyDeclaration } from '../../../../src/tool/dependencies.js';

function tu(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  dependencies?: ToolDependencyDeclaration,
  extractWritePaths?: (input: Record<string, unknown>) => readonly string[],
): OrchestrationToolUse {
  return {
    toolUseId,
    toolName,
    input,
    ...(dependencies ? { dependencies } : {}),
    ...(extractWritePaths ? { extractWritePaths } : {}),
  };
}

const readDecl: ToolDependencyDeclaration = { readPaths: [], writePaths: [] };
const writeDecl = (path: string): ToolDependencyDeclaration => ({
  writePaths: ['__from_input__'],
  readPaths: [],
});
const extractPath =
  (path: string) =>
  (_input: Record<string, unknown>): readonly string[] => [path];

describe('planExecution: independent reads', () => {
  it('packs all reads into a single wave', () => {
    const plan = planExecution([
      tu('r1', 'ReadTool', { path: '/a' }, readDecl),
      tu('r2', 'ReadTool', { path: '/b' }, readDecl),
      tu('r3', 'ReadTool', { path: '/c' }, readDecl),
    ]);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect(plan.unresolved).toEqual([]);
  });
});

describe('planExecution: writes against disjoint paths', () => {
  it('packs disjoint-path writes into a single wave', () => {
    const plan = planExecution([
      tu('w1', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
      tu('w2', 'WriteTool', { path: '/b' }, writeDecl('/b'), extractPath('/b')),
    ]);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual([
      'w1',
      'w2',
    ]);
  });
});

describe('planExecution: writes against the same path', () => {
  it('serialises same-path writes across waves', () => {
    const plan = planExecution([
      tu('w1', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
      tu('w2', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
    ]);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual(['w1']);
    expect(plan.waves[1].toolUses.map((t) => t.toolUseId)).toEqual(['w2']);
  });

  it('respects maxConcurrency when several same-path writes pile up', () => {
    // Three writes to the same path: each one blocks the next, so we
    // get three single-write waves (maxConcurrency=2 only caps the
    // upper bound, not the floor). The test pins the deterministic
    // ordering of same-path writes.
    const plan = planExecution(
      [
        tu('w1', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
        tu('w2', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
        tu('w3', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
      ],
      2,
    );
    expect(plan.waves).toHaveLength(3);
    expect(plan.waves.every((w) => w.toolUses.length === 1)).toBe(true);
    expect(plan.waves.map((w) => w.toolUses[0].toolUseId)).toEqual([
      'w1',
      'w2',
      'w3',
    ]);
  });
});

describe('planExecution: requires', () => {
  it('orders tools by their declared prerequisites', () => {
    const plan = planExecution([
      tu(
        'a',
        'analyze',
        {},
        { requires: ['fetch'] },
      ),
      tu('f', 'fetch'),
    ]);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual(['f']);
    expect(plan.waves[1].toolUses.map((t) => t.toolUseId)).toEqual(['a']);
  });

  it('flags unmet prerequisites as unresolved', () => {
    const plan = planExecution([
      tu('a', 'analyze', {}, { requires: ['fetch'] }),
      tu('b', 'noop'),
    ]);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0].toolUseId).toBe('a');
    expect(plan.unresolved[0].reason).toContain('unmet prerequisite');
    expect(plan.unresolved[0].reason).toContain('fetch');
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual(['b']);
  });
});

describe('planExecution: UNKNOWN_PATHS (conservative default)', () => {
  it('serialises an UNKNOWN_PATHS writer against every other writer', () => {
    const plan = planExecution([
      tu('w1', 'WriteTool', { path: '/a' }, writeDecl('/a'), extractPath('/a')),
      tu('w2', 'BashTool', {}, { writePaths: ['__unknown__'] }),
    ]);
    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0].toolUses.map((t) => t.toolUseId)).toEqual(['w1']);
    expect(plan.waves[1].toolUses.map((t) => t.toolUseId)).toEqual(['w2']);
  });
});

describe('planExecution: empty input', () => {
  it('returns an empty plan when no tool-uses are supplied', () => {
    const plan = planExecution([]);
    expect(plan.waves).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });
});

describe('DEFAULT_MAX_CONCURRENCY', () => {
  it('matches the legacy READ batch limit (5)', () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBe(5);
  });
});