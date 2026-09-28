/**
 * ComputerCuaTool tests (plan 575 Phase 4 gate): schema validation,
 * envelope shape, image lift for get_app_state screenshots, and the
 * no-IPC / IPC-failure error paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COMPUTER_CUA_IPC_CHANNEL, COMPUTER_CUA_TOOLS, definition, executor } from '../ComputerCuaTool.js';
import type { ToolUseContext } from '../../types.js';

function makeContext(overrides: {
  response?: unknown;
  throwErr?: Error;
} = {}): ToolUseContext {
  return {
    ipcRequest: vi.fn(async () => {
      if (overrides.throwErr) throw overrides.throwErr;
      return overrides.response ?? { success: true, tool: 'list_apps', data: [] };
    }),
  } as unknown as ToolUseContext;
}

describe('computer_cua definition', () => {
  it('exposes exactly the 14 aligned tools', () => {
    expect(COMPUTER_CUA_TOOLS).toHaveLength(14);
    expect(definition.input_schema.properties.tool.enum).toEqual([...COMPUTER_CUA_TOOLS]);
    expect(definition.input_schema.required).toEqual(['tool']);
  });
});

describe('computer_cua executor', () => {
  it('rejects unknown tool names as SCHEMA failures (INVALID_APP envelope)', async () => {
    const result = await executor.execute({ tool: 'format_disk' }, undefined, makeContext());
    const envelope = JSON.parse(result.result);
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe('INVALID_APP');
    expect(result.error).toBe(true);
  });

  it('rejects a coordinate target with negative pixels', async () => {
    const result = await executor.execute(
      { tool: 'left_click', target: { type: 'coordinate', x: -1, y: 5 } },
      undefined,
      makeContext(),
    );
    expect(JSON.parse(result.result).success).toBe(false);
  });

  it('returns a structured error when IPC is unavailable', async () => {
    const result = await executor.execute({ tool: 'list_apps' }, undefined, {} as ToolUseContext);
    const envelope = JSON.parse(result.result);
    expect(envelope).toMatchObject({
      success: false,
      tool: 'list_apps',
      error: { code: 'INTERNAL' },
    });
  });

  it('dispatches over computer-use:cua with the session id and echoes data', async () => {
    const context = makeContext({
      response: { success: true, tool: 'list_apps', data: [{ pid: 1, name: 'X' }] },
    });
    const result = await executor.execute({ tool: 'list_apps' }, undefined, context);
    expect(context.ipcRequest).toHaveBeenCalledWith(
      COMPUTER_CUA_IPC_CHANNEL,
      expect.objectContaining({ tool: 'list_apps', sessionId: undefined }),
      expect.objectContaining({ timeout: 15_000 }),
    );
    const envelope = JSON.parse(result.result);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual([{ pid: 1, name: 'X' }]);
  });

  it('uses the long timeout for get_app_state and lifts the screenshot to images', async () => {
    const context = makeContext({
      response: {
        success: true,
        tool: 'get_app_state',
        data: {
          observation: { stateId: 's-1' },
          text: 'app: pid=1',
          screenshot: { base64: 'cG5n', width: 100, height: 50 },
        },
      },
    });
    const result = await executor.execute(
      { tool: 'get_app_state', pid: 1, includeScreenshot: true },
      undefined,
      context,
    );
    expect(context.ipcRequest).toHaveBeenCalledWith(
      COMPUTER_CUA_IPC_CHANNEL,
      expect.objectContaining({ tool: 'get_app_state' }),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(result.images).toEqual([{ data: 'cG5n', mediaType: 'image/png' }]);
    // The base64 must NOT stay in the JSON envelope (kept out of text context).
    expect(result.result).not.toContain('cG5n');
  });

  it('maps typed CUA error envelopes to error results verbatim', async () => {
    const context = makeContext({
      response: {
        success: false,
        tool: 'left_click',
        error: { code: 'ELEMENT_UNAVAILABLE', message: 're-observe first' },
      },
    });
    const result = await executor.execute(
      { tool: 'left_click', target: { type: 'element', index: 0 } },
      undefined,
      context,
    );
    const envelope = JSON.parse(result.result);
    expect(envelope).toMatchObject({
      success: false,
      tool: 'left_click',
      error: { code: 'ELEMENT_UNAVAILABLE', message: 're-observe first' },
    });
    expect(result.error).toBe(true);
  });

  it('wraps IPC exceptions as INTERNAL', async () => {
    const context = makeContext({ throwErr: new Error('bridge gone') });
    const result = await executor.execute({ tool: 'key', key: 'Return' }, undefined, context);
    expect(JSON.parse(result.result).error).toMatchObject({ code: 'INTERNAL' });
  });
});
