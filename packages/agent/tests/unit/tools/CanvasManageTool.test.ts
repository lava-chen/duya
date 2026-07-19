import { describe, expect, it, vi } from 'vitest';
import type { ToolUseContext } from '../../../src/types.js';
import { executor } from '../../../src/tool/CanvasConductor/CanvasManageTool.js';
import { getCanvasId } from '../../../src/tool/CanvasConductor/ipc-request.js';

function makeContext(
  response: { success: boolean; data?: unknown; error?: { code: string; message: string } },
): { context: ToolUseContext; ipcRequest: ReturnType<typeof vi.fn> } {
  const ipcRequest = vi.fn().mockResolvedValue(response);
  const context = {
    options: { sessionId: 'session-1' },
    conductorCanvasId: 'canvas-1',
    canvasTarget: { canvasId: 'canvas-1', canvasName: 'First' },
    canvasFreshness: {
      lastListElementsTime: Date.now(),
      recentlyCreatedElementIds: new Set(['element-1']),
    },
    ipcRequest,
  } as unknown as ToolUseContext;
  return { context, ipcRequest };
}

describe('canvas_manage', () => {
  it('switches the shared target and clears cross-canvas freshness state', async () => {
    const { context, ipcRequest } = makeContext({
      success: true,
      data: {
        action: 'switch',
        currentCanvas: { id: 'canvas-2', name: 'Second' },
        switched: true,
      },
    });

    const result = await executor.execute({ action: 'switch', canvasId: 'canvas-2' }, undefined, context);

    expect(result.error).toBe(false);
    expect(getCanvasId(context)).toBe('canvas-2');
    expect(context.canvasTarget?.canvasName).toBe('Second');
    expect(context.canvasFreshness?.lastListElementsTime).toBeUndefined();
    expect(context.canvasFreshness?.recentlyCreatedElementIds.size).toBe(0);
    expect(ipcRequest).toHaveBeenCalledWith(
      'conductor:executor:rpc',
      {
        action: 'canvas.manage',
        payload: { action: 'switch', currentCanvasId: 'canvas-1', canvasId: 'canvas-2' },
        sessionId: 'session-1',
      },
      { retries: 0 },
    );
  });

  it('can query canvas identity even when no canvas is currently bound', async () => {
    const { context, ipcRequest } = makeContext({
      success: true,
      data: { action: 'get_current', currentCanvas: null },
    });
    context.conductorCanvasId = undefined;
    context.canvasTarget = {};

    const result = await executor.execute({ action: 'get_current' }, undefined, context);

    expect(result.error).toBe(false);
    expect(ipcRequest).toHaveBeenCalledOnce();
  });

  it('rejects rename without a name before calling IPC', async () => {
    const { context, ipcRequest } = makeContext({ success: true });

    const result = await executor.execute({ action: 'rename' }, undefined, context);

    expect(result.error).toBe(true);
    expect(ipcRequest).not.toHaveBeenCalled();
  });

  it('propagates the new canvas id to the mode modifier via updateModeCanvasId on switch', async () => {
    const { context } = makeContext({
      success: true,
      data: {
        action: 'switch',
        currentCanvas: { id: 'canvas-2', name: 'Second' },
        switched: true,
      },
    });
    const updateModeCanvasId = vi.fn();
    context.updateModeCanvasId = updateModeCanvasId;

    await executor.execute({ action: 'switch', canvasId: 'canvas-2' }, undefined, context);

    expect(updateModeCanvasId).toHaveBeenCalledWith('canvas-2');
  });

  it('does not call updateModeCanvasId when the target did not change', async () => {
    const { context } = makeContext({
      success: true,
      data: {
        action: 'switch',
        currentCanvas: { id: 'canvas-1', name: 'First' },
        switched: true,
      },
    });
    const updateModeCanvasId = vi.fn();
    context.updateModeCanvasId = updateModeCanvasId;

    await executor.execute({ action: 'switch', canvasId: 'canvas-1' }, undefined, context);

    expect(updateModeCanvasId).not.toHaveBeenCalled();
  });
});
