/**
 * ToolDependencyDeclaration contract tests — Plan 550 step 3a.
 *
 * Pins the schema contract the new DependencyGraphOrchestrator will
 * rely on. Locks:
 *
 *   - The `normaliseDependencies` defaulting behaviour (every field
 *     falls back to an empty readonly array).
 *   - The `UNKNOWN_PATHS` sentinel semantics — tools that do not
 *     implement `extractWritePaths` opt into conservative serialisation.
 *   - `ReadTool` declares parallel read paths; `WriteTool` declares
 *     single-target writes; `BashTool` opts into unknown-paths so the
 *     orchestrator serialises it against every other writer.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import {
  normaliseDependencies,
  UNKNOWN_PATHS,
} from '../../../src/tool/dependencies.js';
import { ReadTool } from '../../../src/tool/ReadTool/ReadTool.js';
import { WriteTool } from '../../../src/tool/WriteTool/WriteTool.js';
import { BashTool } from '../../../src/tool/BashTool/BashTool.js';

describe('normaliseDependencies', () => {
  it('defaults every field to an empty readonly array', () => {
    const norm = normaliseDependencies(undefined);
    expect(norm.requires).toEqual([]);
    expect(norm.produces).toEqual([]);
    expect(norm.consumes).toEqual([]);
    expect(norm.writePaths).toEqual([]);
    expect(norm.readPaths).toEqual([]);
  });

  it('preserves declared arrays and defaults the rest', () => {
    const norm = normaliseDependencies({
      requires: ['git_status'],
      produces: ['session_search_results'],
    });
    expect(norm.requires).toEqual(['git_status']);
    expect(norm.produces).toEqual(['session_search_results']);
    expect(norm.consumes).toEqual([]);
    expect(norm.writePaths).toEqual([]);
    expect(norm.readPaths).toEqual([]);
  });

  it('coerces undefined members to empty arrays', () => {
    const norm = normaliseDependencies({
      requires: undefined,
      produces: ['x'],
      consumes: undefined,
      writePaths: ['/tmp/a'],
      readPaths: undefined,
    });
    expect(norm.requires).toEqual([]);
    expect(norm.produces).toEqual(['x']);
    expect(norm.consumes).toEqual([]);
    expect(norm.writePaths).toEqual(['/tmp/a']);
    expect(norm.readPaths).toEqual([]);
  });
});

describe('UNKNOWN_PATHS sentinel', () => {
  it('is a frozen singleton array', () => {
    expect(UNKNOWN_PATHS).toEqual(['__unknown__']);
    expect(Object.isFrozen(UNKNOWN_PATHS)).toBe(true);
  });
});

describe('ReadTool dependency declaration', () => {
  const tool = new ReadTool();

  it('declares no write paths and no prerequisites', () => {
    expect(tool.dependencies?.writePaths).toEqual([]);
    expect(tool.dependencies?.requires).toEqual([]);
    expect(tool.dependencies?.produces).toEqual([]);
  });

  it('extractReadPaths returns the input path as the read set', () => {
    expect(tool.extractReadPaths?.({ path: '/tmp/foo.txt' })).toEqual([
      '/tmp/foo.txt',
    ]);
  });

  it('extractReadPaths falls back to UNKNOWN_PATHS when path is missing', () => {
    expect(tool.extractReadPaths?.({})).toEqual(UNKNOWN_PATHS);
  });

  it('extractWritePaths is empty (read-only tool)', () => {
    expect(tool.extractWritePaths?.({ path: '/tmp/foo.txt' })).toEqual([]);
  });
});

describe('WriteTool dependency declaration', () => {
  const tool = new WriteTool();

  it('declares a single-target write that is keyed on the input path', () => {
    expect(tool.dependencies?.writePaths).toEqual(['__from_input__']);
    expect(tool.dependencies?.readPaths).toEqual([]);
  });

  it('extractWritePaths returns the input path as the write set', () => {
    expect(tool.extractWritePaths?.({ path: '/tmp/foo.txt' })).toEqual([
      '/tmp/foo.txt',
    ]);
  });

  it('extractWritePaths falls back to UNKNOWN_PATHS when path is missing', () => {
    expect(tool.extractWritePaths?.({})).toEqual(UNKNOWN_PATHS);
  });

  it('extractReadPaths is empty (pure writer)', () => {
    expect(tool.extractReadPaths?.({ path: '/tmp/foo.txt' })).toEqual([]);
  });
});

describe('BashTool dependency declaration (conservative default)', () => {
  const tool = new BashTool();

  it('opts into the unknown-paths sentinel for both read and write', () => {
    expect(tool.dependencies?.writePaths).toEqual(UNKNOWN_PATHS);
    expect(tool.dependencies?.readPaths).toEqual(UNKNOWN_PATHS);
  });

  it('does not declare prerequisite tools', () => {
    expect(tool.dependencies?.requires).toEqual([]);
    expect(tool.dependencies?.produces).toEqual([]);
    expect(tool.dependencies?.consumes).toEqual([]);
  });
});