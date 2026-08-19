/**
 * policy-classifier-permission.test.ts - regression tests for the
 * tool-name case normalization in the permission gate.
 *
 * Root cause fixed (2026-08-19): built-in tool names are lowercase at the
 * permission gate (`glob`/`grep`/`read`/`write`/`edit`/`bash`/`apply_patch`),
 * but the auto-mode safe allowlist (`SAFE_YOLO_ALLOWLISTED_TOOLS`) and the
 * workspace-boundary list in `isToolWithinWorkspace` only contained
 * capitalized forms (`Glob`/`Grep`/...). Read-only tools like `glob` were
 * therefore never allowlisted in auto mode, fell through to the LLM
 * classifier, and a `glob` over `~/.duya/memory/*` could be denied even
 * though it is a pure read operation.
 */

import { describe, it, expect } from 'vitest';
import { isAutoModeAllowlistedTool } from '../classifier.js';
import { isToolWithinWorkspace } from '../policy.js';
import type { ToolPermissionContext } from '../types.js';

function makeContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    defaultWorkspaceDirectory: 'C:/work/project',
    ...overrides,
  };
}

describe('isAutoModeAllowlistedTool (classifier safe allowlist)', () => {
  it.each([
    ['glob', true],
    ['grep', true],
    ['read', true],
    ['Glob', true], // capitalized variant must still match
    ['Grep', true],
    ['Read', true],
    ['todo', true],
    ['AskUserQuestion', true],
    ['ExitPlanMode', true],
    ['bash', false], // shell execution is never allowlisted
    ['write', false],
    ['edit', false],
    ['Bash', false],
  ])('%s → %s', (name, expected) => {
    expect(isAutoModeAllowlistedTool(name)).toBe(expected);
  });
});

describe('isToolWithinWorkspace (workspace boundary)', () => {
  const context = makeContext();

  it('matches lowercase built-in tool names', () => {
    expect(
      isToolWithinWorkspace('glob', { path: 'C:/work/project/src' }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('grep', { path: 'C:/work/project' }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('read', { file_path: 'C:/work/project/a.ts' }, context),
    ).toBe(true);
  });

  it('matches capitalized variants', () => {
    expect(
      isToolWithinWorkspace('Glob', { path: 'C:/work/project/src' }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('Read', { file_path: 'C:/work/project/a.ts' }, context),
    ).toBe(true);
  });

  it('rejects paths outside the workspace', () => {
    expect(
      isToolWithinWorkspace('glob', { path: 'C:/Users/lavachen/.duya/memory' }, context),
    ).toBe(false);
  });

  it('returns false for tools with no path-bearing input fields', () => {
    // glob's search root lives in `pattern`, which the boundary check does
    // not inspect — the tool must not be treated as workspace-confined
    // purely because a pattern string was passed.
    expect(
      isToolWithinWorkspace('glob', { pattern: 'C:/work/project/**/*.ts' }, context),
    ).toBe(false);
  });

  it('returns false for non-file-system tools', () => {
    expect(isToolWithinWorkspace('SessionSearch', {}, context)).toBe(false);
    expect(isToolWithinWorkspace('TodoWrite', {}, context)).toBe(false);
  });
});
