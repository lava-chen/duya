import { describe, expect, it, vi } from 'vitest';

import type { ToolUseContext } from '../../types.js';
import { executor } from '../ComputerUseTool.js';

describe('Agent computer-use capability adapter', () => {
  it('passes the worker IPC bridge and session through the narrow capability ports', async () => {
    const ipcRequest = vi.fn().mockResolvedValue({
      success: true,
      data: { success: true, action: 'wait' },
    });
    const context = {
      toolUseId: 'tool-1',
      options: { sessionId: 'session-1' },
      ipcRequest,
    } as unknown as ToolUseContext;

    const result = await executor.execute({ action: 'wait', ms: 25 }, undefined, context);

    expect(ipcRequest).toHaveBeenCalledWith(
      'computer-use:execute',
      {
        action: 'wait',
        payload: { action: 'wait', ms: 25 },
        sessionId: 'session-1',
      },
      { timeout: 30_000 },
    );
    expect(JSON.parse(result.result)).toMatchObject({ success: true, action: 'wait' });
  });
});
