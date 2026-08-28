/**
 * ComputerUseTool.test.ts — plan 454 §6.1.
 *
 * Coverage:
 *   - zod schema validation: each action valid + invalid inputs
 *   - tool executor: dispatches via context.ipcRequest
 *   - envelope shape on success / failure
 *   - safety: redacted fields are reported as REDACTED_FIELD in
 *     caller-visible errors (main process enforces; agent side
 *     relies on IPC result)
 */

import { describe, it, expect, vi } from 'vitest';

import {
  definition,
  executor,
  ComputerUseErrorCode,
} from '../ComputerUseTool.js';
import {
  COMPUTER_USE_TOOL_NAME,
  COMPUTER_USE_ACTIONS,
} from '../constants.js';
import { computerUseInputSchema } from '../schema.js';

describe('ComputerUseTool — definition', () => {
  it('uses the canonical tool name', () => {
    expect(definition.name).toBe(COMPUTER_USE_TOOL_NAME);
    expect(definition.name).toBe('computer_use');
  });

  it('lists every action in the schema enum', () => {
    const enumValues = (definition.input_schema as { properties: { action: { enum: string[] } } })
      .properties.action.enum;
    expect(new Set(enumValues)).toEqual(new Set(COMPUTER_USE_ACTIONS));
    expect(enumValues.length).toBe(COMPUTER_USE_ACTIONS.length);
  });
});

describe('computerUseInputSchema', () => {
  it('accepts every action with minimal valid input', () => {
    for (const action of COMPUTER_USE_ACTIONS) {
      const result = computerUseInputSchema.safeParse(minimalValidInput(action));
      expect(result.success, `action ${action} should validate`).toBe(true);
    }
  });

  it('rejects unknown action', () => {
    const r = computerUseInputSchema.safeParse({ action: 'teleport' });
    expect(r.success).toBe(false);
  });

  it('click requires element OR (x,y)', () => {
    const r1 = computerUseInputSchema.safeParse({ action: 'click' });
    expect(r1.success).toBe(false);
    const r2 = computerUseInputSchema.safeParse({ action: 'click', element: 1 });
    expect(r2.success).toBe(true);
    const r3 = computerUseInputSchema.safeParse({ action: 'click', x: 0, y: 0 });
    expect(r3.success).toBe(true);
  });

  it('click element is mutually exclusive with x/y', () => {
    const r = computerUseInputSchema.safeParse({
      action: 'click',
      element: 1,
      x: 0,
      y: 0,
    });
    expect(r.success).toBe(false);
  });

  it('drag requires element-pair OR coord-quad', () => {
    const a = computerUseInputSchema.safeParse({ action: 'drag' });
    expect(a.success).toBe(false);
    const b = computerUseInputSchema.safeParse({
      action: 'drag',
      fromElement: 1,
      toElement: 2,
    });
    expect(b.success).toBe(true);
    const c = computerUseInputSchema.safeParse({
      action: 'drag',
      fromX: 0,
      fromY: 0,
      toX: 100,
      toY: 100,
    });
    expect(c.success).toBe(true);
  });

  it('wait requires positive ms', () => {
    const r = computerUseInputSchema.safeParse({ action: 'wait', ms: 0 });
    expect(r.success).toBe(false);
  });

  it('scroll requires amount > 0', () => {
    const r = computerUseInputSchema.safeParse({
      action: 'scroll',
      direction: 'up',
      amount: 0,
    });
    expect(r.success).toBe(false);
  });

  it('text input is capped at 50k chars', () => {
    const r = computerUseInputSchema.safeParse({
      action: 'type',
      text: 'x'.repeat(50_001),
    });
    expect(r.success).toBe(false);
  });

  it('accepts click count=single (default), double, triple', () => {
    expect(computerUseInputSchema.safeParse({ action: 'click', x: 1, y: 2, count: 'single' }).success).toBe(true);
    expect(computerUseInputSchema.safeParse({ action: 'click', x: 1, y: 2, count: 'double' }).success).toBe(true);
    expect(computerUseInputSchema.safeParse({ action: 'click', x: 1, y: 2, count: 'triple' }).success).toBe(true);
  });

  it('rejects click count with an unknown value', () => {
    const r = computerUseInputSchema.safeParse({
      action: 'click',
      x: 1,
      y: 2,
      count: 'quadruple',
    });
    expect(r.success).toBe(false);
  });

  it('accepts zoom with positive region', () => {
    const r = computerUseInputSchema.safeParse({
      action: 'zoom',
      x: 100,
      y: 200,
      w: 400,
      h: 300,
    });
    expect(r.success).toBe(true);
  });

  it('rejects zoom with non-positive dimensions', () => {
    const r1 = computerUseInputSchema.safeParse({ action: 'zoom', x: 0, y: 0, w: 0, h: 100 });
    expect(r1.success).toBe(false);
    const r2 = computerUseInputSchema.safeParse({ action: 'zoom', x: 0, y: 0, w: 100, h: 0 });
    expect(r2.success).toBe(false);
  });

  it('type accepts empty text', () => {
    const r = computerUseInputSchema.safeParse({ action: 'type', text: '' });
    expect(r.success).toBe(true);
  });

  it('window_switch requires title or processName', () => {
    const r = computerUseInputSchema.safeParse({ action: 'window_switch' });
    expect(r.success).toBe(false);
    const r2 = computerUseInputSchema.safeParse({
      action: 'window_switch',
      title: 'foo',
    });
    expect(r2.success).toBe(true);
  });
});

function minimalValidInput(action: string): Record<string, unknown> {
  switch (action) {
    case 'capture':
      return { action: 'capture' };
    case 'click':
      return { action: 'click', x: 0, y: 0 };
    case 'type':
      return { action: 'type', text: 'hi' };
    case 'key':
      return { action: 'key', key: 'Enter' };
    case 'scroll':
      return { action: 'scroll', direction: 'down', amount: 3 };
    case 'drag':
      return { action: 'drag', fromX: 0, fromY: 0, toX: 1, toY: 1 };
    case 'window_switch':
      return { action: 'window_switch', title: 'x' };
    case 'list_apps':
      return { action: 'list_apps' };
    case 'set_value':
      return { action: 'set_value', value: 'v' };
    case 'wait':
      return { action: 'wait', ms: 100 };
    case 'zoom':
      return { action: 'zoom', x: 0, y: 0, w: 100, h: 100 };
    default:
      return { action };
  }
}

describe('ComputerUseTool.executor', () => {
  it('returns SCHEMA_INVALID for bad input', async () => {
    const result = await executor.execute({ action: 'teleport' }, undefined, {
      options: { sessionId: 's1' },
    } as never);
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe(ComputerUseErrorCode.SCHEMA_INVALID);
  });

  it('returns NO_IPC when context has no ipcRequest', async () => {
    const result = await executor.execute(
      { action: 'wait', ms: 10 },
      undefined,
      { options: { sessionId: 's1' } } as never,
    );
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe(ComputerUseErrorCode.NO_IPC);
  });

  it('dispatches via context.ipcRequest and unwraps the envelope', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: true,
        action: 'wait',
      },
    });
    const result = await executor.execute(
      { action: 'wait', ms: 25 },
      undefined,
      {
        ipcRequest,
        options: { sessionId: 'session-abc' },
      } as never,
    );
    expect(ipcRequest).toHaveBeenCalledTimes(1);
    const [channel, payload] = ipcRequest.mock.calls[0];
    expect(channel).toBe('computer-use:execute');
    expect(payload.action).toBe('wait');
    expect(payload.sessionId).toBe('session-abc');
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('wait');
  });

  it('surfaces IPC-level error codes', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'BACKEND_UNAVAILABLE', message: 'desktop not ready' },
    });
    const result = await executor.execute(
      { action: 'capture' },
      undefined,
      {
        ipcRequest,
        options: { sessionId: 's' },
      } as never,
    );
    expect(result.error).toBe(true);
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe('BACKEND_UNAVAILABLE');
    expect(parsed.error.message).toMatch(/desktop not ready/);
  });

  it('catches ipcRequest exceptions and returns IPC_EXCEPTION', async () => {
    const ipcRequest = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const result = await executor.execute(
      { action: 'wait', ms: 10 },
      undefined,
      {
        ipcRequest,
        options: { sessionId: 's' },
      } as never,
    );
    const parsed = JSON.parse(result.result);
    expect(parsed.error.code).toBe(ComputerUseErrorCode.IPC_EXCEPTION);
    expect(parsed.error.message).toMatch(/socket hang up/);
  });
});