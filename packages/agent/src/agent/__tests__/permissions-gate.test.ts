/**
 * Contract tests for `buildPermissions` (PermissionsGate).
 *
 * Pins the deny-reason propagation contract: whenever the gate returns
 * `allowed: false`, the executor's "Permission denied: tool X cannot be
 * used" fallback must be replaceable by a real reason. Three deny sources
 * are covered — the permission engine, the plan-mode write gate, and the
 * fail-closed catch — plus the allow/ask passthrough shapes.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildPermissions } from '../PermissionsGate.js';
import type { PermissionsGateDeps } from '../PermissionsGate.js';
import { TurnContext } from '../TurnContext.js';
import type { ModeCoordinator } from '../modes/engine/index.js';
import type { AIClient } from '@duya/ai';

function makeTurn(workingDirectory = '/wd'): TurnContext {
  return new TurnContext({
    turnId: { sequence: 1, id: 'turn-1' },
    sessionId: 'sess-1',
    workingDirectory,
    permissionMode: 'default',
    additionalWorkingDirectories: new Map(),
    approval: { alwaysAllowTools: new Set<string>() },
    mentions: { skills: [], plugins: [], contexts: [] },
    promptText: '',
  });
}

function makeDeps(
  overrides: Partial<PermissionsGateDeps> = {},
): PermissionsGateDeps {
  return {
    getPermissionMode: () => 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
    defaultWorkspaceDirectory: '/wd',
    getAbortController: () => new AbortController(),
    llmClient: {} as AIClient,
    model: 'test-model',
    getMessages: () => [],
    hasPermissionsToUseTool: vi.fn(async () => ({ behavior: 'ask' as const })),
    getModeCoordinator: () => undefined,
    ...overrides,
  };
}

describe('buildPermissions deny-reason propagation', () => {
  it('passes the engine deny message through to the executor', async () => {
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: vi.fn(async () => ({
          behavior: 'deny' as const,
          message: 'Permission to use Bash has been denied.',
        })),
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('Bash', { command: 'ls' });
    expect(result).toEqual({
      allowed: false,
      behavior: 'deny',
      message: 'Permission to use Bash has been denied.',
    });
  });

  it('omits the message key when the engine denies without one', async () => {
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: vi.fn(async () => ({
          behavior: 'deny' as const,
        })),
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('Bash', { command: 'ls' });
    expect(result).toEqual({ allowed: false, behavior: 'deny' });
  });

  it('allows ask decisions through without a message', async () => {
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: vi.fn(async () => ({
          behavior: 'ask' as const,
          message: 'ask the user',
        })),
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('Bash', { command: 'ls' });
    expect(result).toEqual({ allowed: true, behavior: 'ask' });
  });

  it('returns the plan-mode gate message and never reaches the engine', async () => {
    const engine = vi.fn(async () => ({ behavior: 'allow' as const }));
    const gate = vi.fn(() => ({
      decision: 'deny' as const,
      message: 'bash blocked by plan mode: shell/module tools cannot be confined.',
    }));
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: engine,
        getModeCoordinator: () =>
          ({ gateWriteTool: gate }) as unknown as ModeCoordinator,
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('bash', { command: 'ls' });
    expect(result).toEqual({
      allowed: false,
      behavior: 'deny',
      message: 'bash blocked by plan mode: shell/module tools cannot be confined.',
    });
    expect(gate).toHaveBeenCalledOnce();
    expect(engine).not.toHaveBeenCalled();
  });

  it('short-circuits allow when the plan-mode gate approves the plan file', async () => {
    const engine = vi.fn(async () => ({ behavior: 'ask' as const }));
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: engine,
        getModeCoordinator: () =>
          ({
            gateWriteTool: () => ({ decision: 'allow' as const }),
          }) as unknown as ModeCoordinator,
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('write', { file_path: '/wd/plan.md' });
    expect(result).toEqual({ allowed: true, behavior: 'allow' });
    expect(engine).not.toHaveBeenCalled();
  });

  it('fail-closed errors carry the reason in the message', async () => {
    const { canUseTool } = buildPermissions(
      makeDeps({
        hasPermissionsToUseTool: vi.fn(async () => {
          throw new Error('Aborted');
        }),
      }),
      makeTurn(),
      undefined,
    );

    const result = await canUseTool('Bash', { command: 'ls' });
    expect(result.allowed).toBe(false);
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('fail-closed');
    expect(result.message).toContain('Aborted');
  });
});
