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

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
  // Plan 583 / ISS-35: the boundary test now delegates to `isPathWithinRoots`,
  // which realpaths the roots and SKIPS a root that does not exist. So these
  // cases need a workspace that actually exists on disk. That tightening only
  // ever removes an auto-allow fast path (this function answers "may we skip
  // the prompt?"), never a hard gate, so a missing root degrades to "ask the
  // user" rather than to "allowed".
  // TWO separate temp trees. The root set deliberately includes the
  // workspace's PARENT directory (so a subdirectory-of-a-repo workspace
  // still works), which means anything under the parent is legitimately
  // in-bounds. To demonstrate a real escape the target has to live outside
  // the parent tree too.
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'duya-ws-'));
  const outsiderRoot = mkdtempSync(path.join(tmpdir(), 'duya-out-'));
  const workspace = path.join(workspaceRoot, 'project');
  const outside = path.join(outsiderRoot, 'secrets');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });

  const context = makeContext({ defaultWorkspaceDirectory: workspace });

  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsiderRoot, { recursive: true, force: true });
  });

  it('matches lowercase built-in tool names', () => {
    expect(
      isToolWithinWorkspace('glob', { path: path.join(workspace, 'src') }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('grep', { path: workspace }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('read', { file_path: path.join(workspace, 'a.ts') }, context),
    ).toBe(true);
  });

  it('matches capitalized variants', () => {
    expect(
      isToolWithinWorkspace('Glob', { path: path.join(workspace, 'src') }, context),
    ).toBe(true);
    expect(
      isToolWithinWorkspace('Read', { file_path: path.join(workspace, 'a.ts') }, context),
    ).toBe(true);
  });

  it('rejects paths outside the workspace', () => {
    expect(
      isToolWithinWorkspace('glob', { path: outside }, context),
    ).toBe(false);
  });

  it('rejects a symlink inside the workspace that points outside it', () => {
    // The regression for ISS-35: the old inline `path.relative` loop never
    // realpath'd either side, so this passed and the tool was auto-allowed
    // against a path outside every declared root.
    const link = path.join(workspace, 'escape-link');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      // Creating links can require elevation on some Windows configurations.
      // Without the fixture we cannot assert the behaviour; skip rather than
      // assert something we did not exercise.
      return;
    }
    expect(isToolWithinWorkspace('read', { path: link }, context)).toBe(false);
  });

  it('returns false for tools with no path-bearing input fields', () => {
    // glob's search root lives in `pattern`, which the boundary check does
    // not inspect — the tool must not be treated as workspace-confined
    // purely because a pattern string was passed.
    expect(
      isToolWithinWorkspace('glob', { pattern: `${workspace}/**/*.ts` }, context),
    ).toBe(false);
  });

  it('returns false for non-file-system tools', () => {
    expect(isToolWithinWorkspace('SessionSearch', {}, context)).toBe(false);
    expect(isToolWithinWorkspace('TodoWrite', {}, context)).toBe(false);
  });

  it('returns false when neither the workspace nor its parent exists', () => {
    // `isPathWithinRoots` realpaths each root and skips one that does not
    // exist, so a workspace that was never created yields no anchor at all.
    // This only removes an auto-allow fast path: the call still falls through
    // to the normal permission flow.
    const orphanParent = path.join(outsiderRoot, 'never', 'created');
    const missing = makeContext({ defaultWorkspaceDirectory: orphanParent });
    expect(
      isToolWithinWorkspace('read', { path: path.join(orphanParent, 'a.ts') }, missing),
    ).toBe(false);
  });
});
