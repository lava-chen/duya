/**
 * gui-backend.test.ts — worker-side production GuiBackendPort mapping
 * (plan 556 Phase 4 wiring). The port is a pure translator between the
 * gui-runner step contract and the main-process computer-use dispatcher
 * envelopes — every test pins one mapping edge.
 */

import { describe, expect, it } from 'vitest';

import { createIpcGuiBackend, type ComputerUseRequest } from '../gui-backend.js';
import type { GuiStep } from '../../modes/workflow/schema.js';

interface RecordedCall {
  action: string;
  payload: Record<string, unknown>;
  options?: { timeout?: number };
}

function mockRequest(
  responder: (call: { action: string; payload: Record<string, unknown> }) => {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  },
): { request: ComputerUseRequest; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const request: ComputerUseRequest = async (action, payload, options) => {
    calls.push({ action, payload, ...(options ? { options } : {}) });
    return responder({ action, payload });
  };
  return { request, calls };
}

const CTX = { runId: 'run-1', nodeId: 'gui:chrome' } as const;

describe('createIpcGuiBackend', () => {
  it('capture passes somMode and maps the CaptureResult envelope', async () => {
    const { request, calls } = mockRequest(() => ({
      success: true,
      data: { base64: 'png-bytes', width: 1920, height: 1080, elements: [{ index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'A' }] },
    }));
    const backend = createIpcGuiBackend(request);
    const shot = await backend.capture(CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('capture');
    expect(calls[0].payload).toEqual({ somMode: true });
    expect(shot.base64).toBe('png-bytes');
    expect(shot.width).toBe(1920);
    expect(shot.height).toBe(1080);
    expect(shot.elements).toHaveLength(1);
  });

  it('capture throws on a failed envelope', async () => {
    const { request } = mockRequest(() => ({
      success: false,
      error: { code: 'BACKEND_UNAVAILABLE', message: 'no display' },
    }));
    const backend = createIpcGuiBackend(request);
    await expect(backend.capture(CTX)).rejects.toThrow('no display');
  });

  it('click resolves som:<n> to the element index and surfaces the verdict effect', async () => {
    const { request, calls } = mockRequest(() => ({
      success: true,
      data: { ok: true, verdict: { effect: 'confirmed' } },
    }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'click', element: 'som:7' } as GuiStep, CTX);
    expect(calls[0].action).toBe('click');
    expect(calls[0].payload).toEqual({ element: 7 });
    expect(result).toEqual({ ok: true, effect: 'confirmed' });
  });

  it('click fails with the dispatcher message', async () => {
    const { request } = mockRequest(() => ({
      success: false,
      error: { code: 'APP_BLOCKED', message: 'app blocked by access policy' },
    }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'click', element: 'som:3' } as GuiStep, CTX);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('app blocked by access policy');
  });

  it('click rejects a malformed som ref before any RPC', async () => {
    const { request, calls } = mockRequest(() => ({ success: true, data: {} }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'click', element: 'som:0' } as GuiStep, CTX);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('type_text with an element focuses it first, then types', async () => {
    const { request, calls } = mockRequest(() => ({
      success: true,
      data: { typeResult: { ok: true, verdict: { effect: 'suspected_noop' } } },
    }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step(
      { do: 'type_text', text: 'hello', element: 'som:2', verify: true } as GuiStep,
      CTX,
    );
    expect(calls.map((c) => c.action)).toEqual(['click', 'type']);
    expect(calls[0].payload).toEqual({ element: 2 });
    expect(calls[1].payload).toEqual({ text: 'hello' });
    // Nested typeResult verdict feeds the verify ladder.
    expect(result).toEqual({ ok: true, effect: 'suspected_noop' });
  });

  it('type_text without an element types directly', async () => {
    const { request, calls } = mockRequest(() => ({ success: true, data: { typeResult: { ok: true } } }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'type_text', text: 'plain' } as GuiStep, CTX);
    expect(calls.map((c) => c.action)).toEqual(['type']);
    expect(result.ok).toBe(true);
  });

  it('type_text fails when the focus click fails', async () => {
    const { request, calls } = mockRequest(({ action }) =>
      action === 'click'
        ? { success: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'click failed' } }
        : { success: true, data: {} },
    );
    const backend = createIpcGuiBackend(request);
    const result = await backend.step(
      { do: 'type_text', text: 'x', element: 'som:5' } as GuiStep,
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('click failed');
    expect(calls.map((c) => c.action)).toEqual(['click']);
  });

  it('set_value with an element focuses it first, then sets the value', async () => {
    const { request, calls } = mockRequest(() => ({
      success: true,
      data: { ok: true, verdict: { effect: 'confirmed' } },
    }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step(
      { do: 'set_value', text: 'v', element: 'som:4' } as GuiStep,
      CTX,
    );
    expect(calls.map((c) => c.action)).toEqual(['click', 'set_value']);
    expect(calls[1].payload).toEqual({ value: 'v' });
    expect(result).toEqual({ ok: true, effect: 'confirmed' });
  });

  it('key and scroll map verbatim', async () => {
    const { request, calls } = mockRequest(() => ({ success: true, data: { ok: true } }));
    const backend = createIpcGuiBackend(request);
    await backend.step({ do: 'key', key: 'Enter' } as GuiStep, CTX);
    await backend.step({ do: 'scroll', direction: 'down', amount: 3 } as GuiStep, CTX);
    expect(calls[0]).toMatchObject({ action: 'key', payload: { key: 'Enter' } });
    expect(calls[1]).toMatchObject({
      action: 'scroll',
      payload: { direction: 'down', amount: 3 },
    });
  });

  it('maps a thrown RPC error into a failed step result instead of throwing', async () => {
    const request: ComputerUseRequest = async () => {
      throw new Error('ipc bridge gone');
    };
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'key', key: 'Escape' } as GuiStep, CTX);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ipc bridge gone');
  });

  it('a declared capture step re-publishes the fresh index space as frame', async () => {
    const { request } = mockRequest(() => ({
      success: true,
      data: { base64: 'b64', width: 800, height: 600, elements: [] },
    }));
    const backend = createIpcGuiBackend(request);
    const result = await backend.step({ do: 'capture' } as GuiStep, CTX);
    expect(result.ok).toBe(true);
    expect(result.frame).toMatchObject({ width: 800, height: 600, elements: [] });
  });
});
