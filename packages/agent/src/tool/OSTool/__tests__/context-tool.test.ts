/**
 * context-tool.test.ts — plan 519 §3.2 (D2).
 *
 * Coverage:
 *   - trigger registry: the three arm conditions (0-element SOM
 *     capture / suspected_noop click / explicit call), stickiness,
 *     per-session isolation, clearing
 *   - zod schema: valid + invalid inputs for list_apps / focus_app
 *   - executor: IPC dispatch over computer-use:execute, envelope
 *     shape, explicit-call arming
 *   - computer-use-mode inject: unarmed → 1 tool, armed → 2 tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  contextDefinition,
  contextExecutor,
  computerUseContextInputSchema,
  recordComputerUseContextTrigger,
  shouldInjectComputerUseContext,
  getComputerUseContextTriggers,
  clearComputerUseContextTrigger,
} from '../context-tool.js';
import { executor as computerUseExecutor } from '../ComputerUseTool.js';
import {
  COMPUTER_USE_CONTEXT_TOOL_NAME,
  COMPUTER_USE_CONTEXT_ACTIONS,
  COMPUTER_USE_IPC_CHANNEL,
} from '../constants.js';
import { computerUseMode } from '../../../modes/computer-use-mode.js';
import type { ToolRegistration } from '../../../modes/types.js';

const SESSION = 'ctx-test-session';

beforeEach(() => {
  clearComputerUseContextTrigger(SESSION);
  clearComputerUseContextTrigger('other-session');
});

// ─────────────────────────────────────────────────────────────────────
// Trigger registry — the three plan §3.2 conditions
// ─────────────────────────────────────────────────────────────────────

describe('context trigger registry', () => {
  it('is not armed for a fresh session', () => {
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
    expect(shouldInjectComputerUseContext(undefined)).toBe(false);
  });

  // Condition 1: capture(somMode=true) returned 0 elements.
  it('arms on capture-zero-elements', () => {
    recordComputerUseContextTrigger(SESSION, 'capture-zero-elements');
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toEqual(['capture-zero-elements']);
  });

  // Condition 2: last click read back suspected_noop.
  it('arms on click-suspected-noop', () => {
    recordComputerUseContextTrigger(SESSION, 'click-suspected-noop');
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toEqual(['click-suspected-noop']);
  });

  // Condition 3: the model explicitly called the context tool.
  it('arms on explicit-call', () => {
    recordComputerUseContextTrigger(SESSION, 'explicit-call');
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toEqual(['explicit-call']);
  });

  it('is sticky across triggers and idempotent', () => {
    recordComputerUseContextTrigger(SESSION, 'capture-zero-elements');
    recordComputerUseContextTrigger(SESSION, 'capture-zero-elements');
    recordComputerUseContextTrigger(SESSION, 'click-suspected-noop');
    expect(getComputerUseContextTriggers(SESSION).sort()).toEqual([
      'capture-zero-elements',
      'click-suspected-noop',
    ]);
  });

  it('isolates sessions', () => {
    recordComputerUseContextTrigger(SESSION, 'explicit-call');
    expect(shouldInjectComputerUseContext('other-session')).toBe(false);
    recordComputerUseContextTrigger('other-session', 'click-suspected-noop');
    expect(shouldInjectComputerUseContext('other-session')).toBe(true);
    clearComputerUseContextTrigger(SESSION);
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
    expect(shouldInjectComputerUseContext('other-session')).toBe(true);
  });

  it('ignores undefined sessionId', () => {
    recordComputerUseContextTrigger(undefined, 'explicit-call');
    expect(shouldInjectComputerUseContext(undefined)).toBe(false);
    clearComputerUseContextTrigger(undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end trigger recording via the computer_use executor (D2)
// ─────────────────────────────────────────────────────────────────────

describe('computer_use executor → trigger recording', () => {
  function ipcResult(data: unknown): { ipcRequest: ReturnType<typeof vi.fn> } {
    return {
      ipcRequest: vi.fn().mockResolvedValue({ success: true, data }),
    };
  }

  it('arms the escape hatch when a SOM capture returns 0 elements', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'capture',
      data: { width: 100, height: 100, elements: [] },
    });
    await computerUseExecutor.execute(
      { action: 'capture', somMode: true },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toContain('capture-zero-elements');
  });

  it('does NOT arm on a SOM capture with elements', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'capture',
      data: {
        width: 100,
        height: 100,
        elements: [{ index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'A' }],
      },
    });
    await computerUseExecutor.execute(
      { action: 'capture', somMode: true },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
  });

  it('does NOT arm on a non-SOM capture with 0 elements', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'capture',
      data: { width: 100, height: 100, elements: [] },
    });
    await computerUseExecutor.execute(
      { action: 'capture' },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
  });

  it('arms the escape hatch when a click reads back suspected_noop', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'click',
      data: {
        ok: true,
        verdict: {
          effect: 'suspected_noop',
          verified: { elementChanged: false, newFocusedEntity: null },
          escalation: { recommended: 're-capture', reason: 'no change' },
        },
      },
    });
    await computerUseExecutor.execute(
      { action: 'click', element: 3 },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toContain('click-suspected-noop');
  });

  it('does NOT arm on a confirmed click', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'click',
      data: {
        ok: true,
        verdict: {
          effect: 'confirmed',
          verified: { elementChanged: true, newFocusedEntity: null },
        },
      },
    });
    await computerUseExecutor.execute(
      { action: 'click', element: 3 },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
  });

  it('does NOT arm when the session is unknown', async () => {
    const { ipcRequest } = ipcResult({
      success: true,
      action: 'capture',
      data: { width: 1, height: 1, elements: [] },
    });
    await computerUseExecutor.execute(
      { action: 'capture', somMode: true },
      undefined,
      { ipcRequest } as never,
    );
    expect(shouldInjectComputerUseContext(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Schema + definition
// ─────────────────────────────────────────────────────────────────────

describe('computerUseContextInputSchema', () => {
  it('accepts list_apps', () => {
    expect(computerUseContextInputSchema.safeParse({ action: 'list_apps' }).success).toBe(true);
  });

  it('accepts focus_app with title or processName', () => {
    expect(
      computerUseContextInputSchema.safeParse({ action: 'focus_app', title: 'Notepad' }).success,
    ).toBe(true);
    expect(
      computerUseContextInputSchema.safeParse({ action: 'focus_app', processName: 'chrome' })
        .success,
    ).toBe(true);
    expect(
      computerUseContextInputSchema.safeParse({
        action: 'focus_app',
        title: 'Terminal',
        processName: 'WindowsTerminal',
        raise: true,
      }).success,
    ).toBe(true);
  });

  it('rejects focus_app without title/processName', () => {
    expect(computerUseContextInputSchema.safeParse({ action: 'focus_app' }).success).toBe(false);
  });

  it('rejects unknown actions and extra fields', () => {
    expect(computerUseContextInputSchema.safeParse({ action: 'click' }).success).toBe(false);
    expect(
      computerUseContextInputSchema.safeParse({ action: 'list_apps', somMode: true }).success,
    ).toBe(false);
  });
});

describe('contextDefinition', () => {
  it('uses the canonical tool name + action enum', () => {
    expect(contextDefinition.name).toBe(COMPUTER_USE_CONTEXT_TOOL_NAME);
    expect(contextDefinition.name).toBe('computer_use_context');
    const enumValues = (
      contextDefinition.input_schema as { properties: { action: { enum: string[] } } }
    ).properties.action.enum;
    expect(new Set(enumValues)).toEqual(new Set(COMPUTER_USE_CONTEXT_ACTIONS));
  });

  it('documents the raise=false default in the schema', () => {
    const raise = (
      contextDefinition.input_schema as {
        properties: { raise: { description: string } };
      }
    ).properties.raise;
    expect(raise.description).toContain('default false');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Executor
// ─────────────────────────────────────────────────────────────────────

describe('contextExecutor', () => {
  it('returns SCHEMA_INVALID for bad input', async () => {
    const result = await contextExecutor.execute(
      { action: 'focus_app' },
      undefined,
      { options: { sessionId: SESSION } } as never,
    );
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe('SCHEMA_INVALID');
    expect(parsed.error.message).toContain('focus_app requires');
  });

  it('returns NO_IPC when context has no ipcRequest', async () => {
    const result = await contextExecutor.execute(
      { action: 'list_apps' },
      undefined,
      { options: { sessionId: SESSION } } as never,
    );
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe('NO_IPC');
  });

  it('dispatches over computer-use:execute and unwraps the envelope', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: true,
        action: 'list_apps',
        data: {
          apps: [
            { title: 'Doc.txt - Notepad', processName: 'notepad.exe', pid: 42 },
          ],
        },
      },
    });
    const result = await contextExecutor.execute(
      { action: 'list_apps' },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(ipcRequest).toHaveBeenCalledTimes(1);
    const [channel, payload] = ipcRequest.mock.calls[0];
    expect(channel).toBe(COMPUTER_USE_IPC_CHANNEL);
    expect(payload.action).toBe('list_apps');
    expect(payload.sessionId).toBe(SESSION);
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('list_apps');
    expect(parsed.data.apps).toHaveLength(1);
    expect(parsed.data.apps[0].processName).toBe('notepad.exe');
  });

  it('arms explicit-call on success (condition 3)', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: true,
      data: { success: true, action: 'list_apps', data: { apps: [] } },
    });
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
    await contextExecutor.execute(
      { action: 'list_apps' },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(true);
    expect(getComputerUseContextTriggers(SESSION)).toContain('explicit-call');
  });

  it('does not arm on failure', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: false,
        action: 'focus_app',
        error: { code: 'BACKEND_UNAVAILABLE', message: 'no such window' },
      },
    });
    await contextExecutor.execute(
      { action: 'focus_app', title: 'Ghost' },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    expect(shouldInjectComputerUseContext(SESSION)).toBe(false);
  });

  it('surfaces IPC-level errors', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'BACKEND_UNAVAILABLE', message: 'desktop not ready' },
    });
    const result = await contextExecutor.execute(
      { action: 'list_apps' },
      undefined,
      { ipcRequest, options: { sessionId: SESSION } } as never,
    );
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe('BACKEND_UNAVAILABLE');
    expect(parsed.error.message).toMatch(/desktop not ready/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// computer-use-mode inject — conditional injection
// ─────────────────────────────────────────────────────────────────────

describe('computer-use-mode inject — conditional context tool', () => {
  function injectFor(sessionId: string | undefined): ToolRegistration[] {
    return (
      computerUseMode.tools!.inject as (ctx: {
        sessionId: string | undefined;
        workingDirectory: string;
        state: Record<string, never>;
      }) => ToolRegistration[]
    )({ sessionId, workingDirectory: '/tmp', state: {} });
  }

  it('injects only computer_use when unarmed', () => {
    const tools = injectFor(SESSION);
    expect(tools.map((t) => t.definition.name)).toEqual(['computer_use']);
  });

  it('injects both tools when armed (0-element capture path)', () => {
    recordComputerUseContextTrigger(SESSION, 'capture-zero-elements');
    const tools = injectFor(SESSION);
    expect(tools.map((t) => t.definition.name)).toEqual([
      'computer_use',
      'computer_use_context',
    ]);
  });

  it('injects both tools when armed (suspected_noop path)', () => {
    recordComputerUseContextTrigger(SESSION, 'click-suspected-noop');
    expect(injectFor(SESSION).map((t) => t.definition.name)).toContain(
      'computer_use_context',
    );
  });

  it('injects both tools when armed (explicit-call path)', () => {
    recordComputerUseContextTrigger(SESSION, 'explicit-call');
    expect(injectFor(SESSION).map((t) => t.definition.name)).toContain(
      'computer_use_context',
    );
  });

  it('other sessions stay unarmed', () => {
    recordComputerUseContextTrigger(SESSION, 'explicit-call');
    expect(injectFor('other-session').map((t) => t.definition.name)).toEqual([
      'computer_use',
    ]);
  });
});
