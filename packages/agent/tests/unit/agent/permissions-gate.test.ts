/**
 * PermissionsGate unit tests — Plan 550 step 2d.
 *
 * The gate is the assembly point for `permissionContext` and `canUseTool`
 * that `duyaAgent.streamChat` used to inline. These tests pin the
 * assembly contract:
 *
 *   - the per-turn approval ledger (`consumeApprovedEffect` /
 *     `alwaysAllowTools`) takes precedence over the rules engine
 *   - the plan-mode exact-path gate is consulted lazily (the coordinator
 *     can change mid-streamChat and the gate sees the current one)
 *   - `workingDirectory` comes from the turn context, not the
 *     session-scope field
 *   - classifier failures fail closed (deny)
 *   - the `getMessages()` / `getAbortController()` accessors stay live
 *     across `build()` calls (snapshotting would silently drift)
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PermissionsGate,
  buildPermissions,
  type PermissionsGateDeps,
} from '../../../src/agent/PermissionsGate.js';
import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
  TurnContext,
  type ApprovalLedger,
  type TurnContextShape,
} from '../../../src/agent/TurnContext.js';
import type { AIClient } from '../../../src/types.js';

function makeTurn(
  overrides: Partial<{
    approval: ApprovalLedger;
    workingDirectory: string | null;
  }> = {},
): TurnContext {
  const shape: TurnContextShape = {
    turnId: null,
    sessionId: 'session-1',
    workingDirectory: overrides.workingDirectory ?? 'E:\\Projects\\duya',
    permissionMode: 'default',
    additionalWorkingDirectories: new Map(),
    approval: overrides.approval ?? NO_APPROVAL_LEDGER,
    mentions: NO_MENTIONS,
    promptText: 'hello',
  };
  return new TurnContext(shape);
}

function makeDeps(overrides: Partial<PermissionsGateDeps> = {}): PermissionsGateDeps {
  return {
    getPermissionMode: () => 'default',
    hostToolPermission: undefined,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
    defaultWorkspaceDirectory: undefined,
    getAbortController: () => null,
    llmClient: {} as AIClient,
    model: 'claude-sonnet',
    getMessages: () => [],
    hasPermissionsToUseTool: async () => ({ behavior: 'allow' }),
    getModeCoordinator: () => undefined,
    ...overrides,
  };
}

describe('buildPermissions — context assembly', () => {
  it('forwards permissionMode from the deps accessor into the context', () => {
    let mode: 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits' = 'default';
    const deps = makeDeps({ getPermissionMode: () => mode });
    const turn = makeTurn();

    const before = buildPermissions(deps, turn, undefined);
    expect(before.permissionContext.getAppState().toolPermissionContext.mode).toBe('default');

    mode = 'acceptEdits';
    const after = buildPermissions(deps, turn, undefined);
    expect(after.permissionContext.getAppState().toolPermissionContext.mode).toBe('acceptEdits');
  });

  it('plumbs getMessages result into the context (snapshot at build time, matching legacy)', () => {
    const messagesRef = { current: [] as Array<{ role: string; content: string }> };
    const deps = makeDeps({
      getMessages: () => messagesRef.current,
    });
    const turn = makeTurn();

    const built = buildPermissions(deps, turn, undefined);
    expect(built.permissionContext.messages).toEqual([]);
    messagesRef.current = [{ role: 'user', content: 'later' }];
    // Legacy `_buildPermissionContext` snapshots `this.messages` at build
    // time too — the messages field on `permissionContext` is not a live
    // accessor. A follow-up commit can switch to `getMessages` if a
    // classifier actually depends on it.
    expect(built.permissionContext.messages).toEqual([]);
  });

  it('plumbs the abort controller through the live accessor', () => {
    const controller = new AbortController();
    const deps = makeDeps({ getAbortController: () => controller });
    const turn = makeTurn();
    const built = buildPermissions(deps, turn, undefined);
    expect(built.permissionContext.abortController).toBe(controller);
  });

  it('threads additionalWorkingDirectories into the context', () => {
    const map = new Map();
    map.set('E:\\extra', { path: 'E:\\extra', source: 'userSettings' });
    const deps = makeDeps({ additionalWorkingDirectories: map });
    const turn = makeTurn();
    const built = buildPermissions(deps, turn, undefined);
    expect(
      built.permissionContext.getAppState().toolPermissionContext.additionalWorkingDirectories,
    ).toBe(map);
  });
});

describe('buildPermissions — canUseTool precedence', () => {
  it('lets consumeApprovedEffect short-circuit before any other check', async () => {
    const consumeApprovedEffect = vi.fn(async () => true);
    const hasPermissionsToUseTool = vi.fn(async () => {
      throw new Error('rules-engine should not be consulted');
    });
    const turn = makeTurn({
      approval: { alwaysAllowTools: new Set(), consumeApprovedEffect },
    });
    const deps = makeDeps({ hasPermissionsToUseTool });

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Write', { path: 'foo.txt' });
    expect(decision).toEqual({ allowed: true, behavior: 'allow' });
    expect(consumeApprovedEffect).toHaveBeenCalledWith('Write', { path: 'foo.txt' });
  });

  it('lets alwaysAllowTools short-circuit before the rules engine', async () => {
    const hasPermissionsToUseTool = vi.fn(async () => {
      throw new Error('rules-engine should not be consulted');
    });
    const turn = makeTurn({
      approval: { alwaysAllowTools: new Set(['Bash']) },
    });
    const deps = makeDeps({ hasPermissionsToUseTool });

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Bash', { command: 'ls' });
    expect(decision).toEqual({ allowed: true, behavior: 'allow' });
  });

  it('honours plan-mode exact-path deny', async () => {
    const gateWriteTool = vi.fn(() => 'deny' as const);
    const getModeCoordinator = vi.fn(() => ({ gateWriteTool }) as never);
    const hasPermissionsToUseTool = vi.fn(async () => {
      throw new Error('rules-engine should not be consulted when gate denies');
    });
    const deps = makeDeps({ hasPermissionsToUseTool, getModeCoordinator });
    const turn = makeTurn();

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Write', { path: 'foo.txt' });
    expect(decision).toEqual({ allowed: false, behavior: 'deny' });
    expect(gateWriteTool).toHaveBeenCalledWith(
      'Write',
      { path: 'foo.txt' },
      'E:\\Projects\\duya',
    );
  });

  it('honours plan-mode exact-path allow and skips the rules engine', async () => {
    const gateWriteTool = vi.fn(() => 'allow' as const);
    const getModeCoordinator = vi.fn(() => ({ gateWriteTool }) as never);
    const hasPermissionsToUseTool = vi.fn(async () => {
      throw new Error('rules-engine should not be consulted when gate allows');
    });
    const deps = makeDeps({ hasPermissionsToUseTool, getModeCoordinator });
    const turn = makeTurn();

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Write', { path: 'plans/x.md' });
    expect(decision).toEqual({ allowed: true, behavior: 'allow' });
  });

  it('falls through to hasPermissionsToUseTool when no short-circuit fires', async () => {
    const hasPermissionsToUseTool = vi.fn(async () => ({
      behavior: 'ask' as const,
      message: 'approval required',
    }));
    const deps = makeDeps({ hasPermissionsToUseTool });
    const turn = makeTurn();

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(decision).toEqual({ allowed: true, behavior: 'ask' });
  });

  it('fail-closes when hasPermissionsToUseTool throws', async () => {
    const hasPermissionsToUseTool = vi.fn(async () => {
      throw new Error('classifier exploded');
    });
    const deps = makeDeps({ hasPermissionsToUseTool });
    const turn = makeTurn();

    const { canUseTool } = buildPermissions(deps, turn, undefined);
    const decision = await canUseTool('Bash', { command: 'echo' });
    expect(decision).toEqual({ allowed: false, behavior: 'deny' });
  });
});

describe('PermissionsGate class facade', () => {
  it('exposes build(turn, registry) delegating to buildPermissions', () => {
    const deps = makeDeps();
    const gate = new PermissionsGate(deps);
    const turn = makeTurn();

    const a = gate.build(turn, undefined);
    const b = buildPermissions(deps, turn, undefined);
    expect(a.permissionContext.getAppState().toolPermissionContext.mode).toBe(
      b.permissionContext.getAppState().toolPermissionContext.mode,
    );
  });

  it('re-reads live deps on every build (no snapshotting)', () => {
    let mode: 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits' = 'default';
    const deps = makeDeps({ getPermissionMode: () => mode });
    const gate = new PermissionsGate(deps);
    const turn = makeTurn();

    const first = gate.build(turn, undefined);
    expect(first.permissionContext.getAppState().toolPermissionContext.mode).toBe('default');
    mode = 'bypassPermissions';
    const second = gate.build(turn, undefined);
    expect(second.permissionContext.getAppState().toolPermissionContext.mode).toBe(
      'bypassPermissions',
    );
  });
});