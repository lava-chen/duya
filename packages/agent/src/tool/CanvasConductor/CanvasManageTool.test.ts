/**
 * canvas_manage tool — payload assembly & result handling tests.
 *
 * Plan 233: validates per-action input shaping (canvasId vs name resolution,
 * switch/delete fallback rules, rename with new name).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

// CanvasManageTool uses crypto.randomUUID() at the module top level
// (Node 19+ exposes webcrypto on globalThis; the vitest node environment
// doesn't always wire it, so we pin it here).
if (!globalThis.crypto) {
  // @ts-expect-error assign webcrypto to globalThis
  globalThis.crypto = webcrypto;
}

const mocks = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
}));

vi.mock('./ipc-request.js', () => ({
  getCanvasId: (context: { canvasTarget?: { canvasId?: string }; conductorCanvasId?: string }) => {
    const id = context.canvasTarget?.canvasId ?? context.conductorCanvasId;
    if (!id) throw new Error('no canvasId');
    return id;
  },
  ipcRequest: mocks.ipcRequest,
  noContextResult: (name: string) => ({
    id: 'fixed',
    name,
    result: JSON.stringify({ success: false, error: { code: 'NO_CONTEXT', message: 'Tool execution context not available' } }),
    error: true as const,
  }),
}));

import { executor, definition } from './CanvasManageTool';

type IpcCall = [channel: string, msg: { action: string; payload: Record<string, unknown>; sessionId: string }, options?: unknown];

function makeContext(currentCanvasId = 'canvas-current') {
  return {
    canvasTarget: { canvasId: currentCanvasId, canvasName: 'Current' },
    conductorCanvasId: currentCanvasId,
    canvasFreshness: { recentlyCreatedElementIds: new Set<string>() },
    ipcRequest: mocks.ipcRequest,
    options: { sessionId: 'session-1' },
  };
}

/** Read the payload object sent to the executor from the most recent IPC call. */
function lastPayload(): Record<string, unknown> {
  const calls = mocks.ipcRequest.mock.calls as IpcCall[];
  const call = calls[calls.length - 1];
  if (!call) throw new Error('ipcRequest was never called. Calls=' + JSON.stringify(mocks.ipcRequest.mock.calls.length));
  return call[2];
}

describe('canvas_manage tool — plan 233', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipcRequest.mockResolvedValue({
      success: true,
      data: {
        action: 'noop',
        canvas: { id: 'canvas-current', name: 'Current' },
        currentCanvas: { id: 'canvas-current', name: 'Current' },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('action enum validation', () => {
    it('rejects unknown actions with a precise list', async () => {
      const result = await executor.execute({ action: 'explode' }, undefined, makeContext());
      expect(result.error).toBe(true);
      const body = JSON.parse(result.result);
      expect(body.error.code).toBe('INVALID_INPUT');
      expect(body.error.message).toContain('get_current');
      expect(body.error.message).toContain('delete');
    });
  });

  describe('create', () => {
    it('forwards name + description + switchTo to the executor', async () => {
      await executor.execute(
        { action: 'create', name: ' New board ', description: ' desc ', switchTo: false },
        undefined,
        makeContext(),
      );
      const payload = lastPayload();
      expect(payload).toMatchObject({
        action: 'create',
        name: 'New board',
        description: 'desc',
        switchTo: false,
      });
    });

    it('rejects create without a name', async () => {
      const result = await executor.execute({ action: 'create' }, undefined, makeContext());
      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error.message).toContain('name is required for create');
    });
  });

  describe('switch', () => {
    it('accepts canvasId', async () => {
      await executor.execute({ action: 'switch', canvasId: 'canvas-target' }, undefined, makeContext());
      const payload = lastPayload();
      expect(payload).toMatchObject({ action: 'switch', canvasId: 'canvas-target' });
      expect(payload.name).toBeUndefined();
    });

    it('accepts name as an alternative to canvasId', async () => {
      await executor.execute({ action: 'switch', name: 'Workbench' }, undefined, makeContext());
      const payload = lastPayload();
      expect(payload).toMatchObject({ action: 'switch', name: 'Workbench' });
      expect(payload.canvasId).toBeUndefined();
    });

    it('forwards both canvasId and name when both are supplied', async () => {
      await executor.execute(
        { action: 'switch', canvasId: 'canvas-by-id', name: 'Workbench' },
        undefined,
        makeContext(),
      );
      const payload = lastPayload();
      expect(payload.canvasId).toBe('canvas-by-id');
      expect(payload.name).toBe('Workbench');
    });

    it('rejects switch with neither canvasId nor name', async () => {
      const result = await executor.execute({ action: 'switch' }, undefined, makeContext());
      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error.message).toContain('canvasId or name');
    });
  });

  describe('rename', () => {
    it('uses canvasId for addressing; name is the new label', async () => {
      await executor.execute(
        { action: 'rename', canvasId: 'canvas-x', name: 'Renamed' },
        undefined,
        makeContext(),
      );
      const payload = lastPayload();
      expect(payload).toMatchObject({
        action: 'rename',
        canvasId: 'canvas-x',
        name: 'Renamed',
      });
    });

    it('defaults the canvasId to the current canvas', async () => {
      await executor.execute({ action: 'rename', name: 'Renamed' }, undefined, makeContext('canvas-current'));
      const payload = lastPayload();
      expect(payload.canvasId).toBe('canvas-current');
      expect(payload.name).toBe('Renamed');
    });

    it('rejects rename without a new name', async () => {
      const result = await executor.execute({ action: 'rename' }, undefined, makeContext());
      expect(result.error).toBe(true);
      expect(JSON.parse(result.result).error.message).toContain('name is required for rename');
    });
  });

  describe('delete', () => {
    it('targets the canvas by canvasId when supplied', async () => {
      await executor.execute({ action: 'delete', canvasId: 'canvas-x' }, undefined, makeContext());
      const payload = lastPayload();
      expect(payload).toMatchObject({ action: 'delete', canvasId: 'canvas-x' });
    });

    it('targets the canvas by name when supplied', async () => {
      await executor.execute({ action: 'delete', name: 'Workbench' }, undefined, makeContext());
      const payload = lastPayload();
      expect(payload).toMatchObject({ action: 'delete', name: 'Workbench' });
    });

    it('falls back to the current canvas when neither is given', async () => {
      await executor.execute({ action: 'delete' }, undefined, makeContext('canvas-current'));
      const payload = lastPayload();
      expect(payload.canvasId).toBe('canvas-current');
    });
  });

  describe('result handling', () => {
    it('updates the bound canvasId on successful switch', async () => {
      const ctx = makeContext('canvas-old');
      mocks.ipcRequest.mockResolvedValueOnce({
        success: true,
        data: {
          action: 'switch',
          currentCanvas: { id: 'canvas-new', name: 'New' },
          canvas: { id: 'canvas-new', name: 'New' },
        },
      });
      await executor.execute({ action: 'switch', canvasId: 'canvas-new' }, undefined, ctx);
      expect(ctx.canvasTarget.canvasId).toBe('canvas-new');
      expect(ctx.canvasTarget.canvasName).toBe('New');
    });

    it('clears the bound canvasId when the current canvas is deleted', async () => {
      const ctx = makeContext('canvas-current');
      mocks.ipcRequest.mockResolvedValueOnce({
        success: true,
        data: {
          action: 'delete',
          deleted: true,
          canvas: { id: 'canvas-current', name: 'Current' },
          currentCanvas: undefined,
        },
      });
      await executor.execute({ action: 'delete', canvasId: 'canvas-current' }, undefined, ctx);
      expect(ctx.canvasTarget.canvasId).toBeUndefined();
      expect(ctx.canvasTarget.canvasName).toBeUndefined();
    });
  });

  describe('tool definition', () => {
    it('exposes all six actions in the schema', () => {
      const actionEnum = (definition.input_schema.properties as { action: { enum: string[] } }).action.enum;
      expect(actionEnum).toEqual(['get_current', 'list', 'create', 'switch', 'rename', 'delete']);
    });
  });
});