import { describe, expect, it, vi } from 'vitest';
import type { ToolUseContext } from '../../../src/types.js';
import { executor } from '../../../src/tool/CanvasConductor/DatabaseTool.js';

function makeContext(
  response: { success: boolean; data?: unknown; error?: { code: string; message: string } } = { success: true, data: {} },
): { context: ToolUseContext; ipcRequest: ReturnType<typeof vi.fn> } {
  const ipcRequest = vi.fn().mockResolvedValue(response);
  const context = {
    options: { sessionId: 'session-1' },
    conductorCanvasId: 'canvas-1',
    canvasTarget: { canvasId: 'canvas-1' },
    ipcRequest,
  } as unknown as ToolUseContext;
  return { context, ipcRequest };
}

describe('database_manage', () => {
  it('maps source creation to a structured database command', async () => {
    const { context, ipcRequest } = makeContext({
      success: true,
      data: { source: { id: 'source-1' }, defaultView: { id: 'view-1' } },
    });

    const result = await executor.execute({ action: 'create_source', name: 'Tasks' }, undefined, context);

    expect(result.error).toBe(false);
    expect(ipcRequest).toHaveBeenCalledWith(
      'conductor:executor:rpc',
      {
        action: 'database.execute',
        payload: {
          canvasId: 'canvas-1',
          command: { type: 'source.create', name: 'Tasks', actor: 'agent' },
        },
        sessionId: 'session-1',
      },
      { retries: 0 },
    );
  });

  it('requires a revision before updating a record', async () => {
    const { context, ipcRequest } = makeContext();

    const result = await executor.execute({
      action: 'update_record',
      sourceId: 'source-1',
      recordId: 'record-1',
      title: 'Changed',
    }, undefined, context);

    expect(result.error).toBe(true);
    expect(ipcRequest).not.toHaveBeenCalled();
  });

  it('keeps project paths out of the model-facing request', async () => {
    const { context, ipcRequest } = makeContext();

    await executor.execute({ action: 'list_sources' }, undefined, context);

    const request = ipcRequest.mock.calls[0]?.[1];
    expect(JSON.stringify(request)).not.toContain('projectPath');
    expect(JSON.stringify(request)).not.toContain('database.sqlite');
  });
});
