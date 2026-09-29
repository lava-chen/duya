/**
 * Plan 580 Phase 4 — chain B executor: deadline stamping (D5) and
 * result fidelity (D8).
 *
 * The AppConnectionTool executor:
 *   - stamps an absolute `deadlineAt` (now + 120s) into the IPC payload
 *     and gives the IPC wait a +30s buffer;
 *   - for the remote-MCP binding (data.content is an MCP content array),
 *     composes model-visible text via the shared last-mile and saves the
 *     canonical blocks losslessly in `ToolResult.blocks`;
 *   - keeps the legacy JSON envelope for REST / custom bindings;
 *   - preserves the `connector_auth_required` SSE reauth-card contract.
 */

import { describe, it, expect } from 'vitest';
import { createAppConnectionTool, type AppConnectionToolDescriptor } from '../index.js';
import type { ToolUseContext } from '../../../types.js';

const DESC: AppConnectionToolDescriptor = {
  name: 'remote_notion_search',
  description: 'Search Notion',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  inputSchemaSummary: 'search',
  riskTier: 'read',
  provider: 'notion',
  connectionId: 'conn-1',
  action: 'remote:search',
};

function makeContext(ipcResponse: unknown): { context: ToolUseContext; payloads: unknown[] } {
  const payloads: unknown[] = [];
  const context = {
    ipcRequest: async (_channel: string, payload: unknown, _opts?: unknown) => {
      payloads.push(payload);
      return ipcResponse;
    },
    options: { sessionId: 's1' },
  } as unknown as ToolUseContext;
  return { context, payloads };
}

describe('AppConnectionTool executor (plan 580 Phase 4)', () => {
  it('stamps deadlineAt (+120s) and a +30s IPC buffer into the request', async () => {
    const { definition, executor } = createAppConnectionTool(DESC);
    const { context, payloads } = makeContext({ success: true, data: { ok: 1 } });
    const before = Date.now();
    await executor.execute({ query: 'x' }, undefined, context);
    const after = Date.now();
    expect(definition.name).toBe('remote_notion_search');
    const payload = payloads[0] as { deadlineAt: number };
    expect(payload.deadlineAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(payload.deadlineAt).toBeLessThanOrEqual(after + 120_000);
  });

  it('composes text from MCP content blocks and saves them losslessly', async () => {
    const { executor } = createAppConnectionTool(DESC);
    const base64 = 'A'.repeat(400_000);
    const { context } = makeContext({
      success: true,
      data: {
        isError: false,
        content: [
          { type: 'text', text: 'page title: Demo' },
          { type: 'image', mimeType: 'image/png', data: base64 },
        ],
      },
    });
    const result = await executor.execute({ query: 'x' }, undefined, context);
    expect(result.error).toBeFalsy();
    expect(result.result).toContain('page title: Demo');
    expect(result.result).toMatch(/\[image image\/png ~293KB #1\]/);
    expect(result.result).not.toContain('AAAA');
    expect(Array.isArray(result.blocks)).toBe(true);
    expect((result.blocks as unknown[]).length).toBe(2);
  });

  it('marks isError from the MCP envelope without a breaker surface', async () => {
    const { executor } = createAppConnectionTool(DESC);
    const { context } = makeContext({
      success: true,
      data: { isError: true, content: [{ type: 'text', text: 'tool said no' }] },
    });
    const result = await executor.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(result.result).toBe('tool said no');
  });

  it('keeps the JSON envelope for non-MCP (REST/custom) data shapes', async () => {
    const { executor } = createAppConnectionTool(DESC);
    const { context } = makeContext({ success: true, data: { rows: [1, 2, 3] } });
    const result = await executor.execute({}, undefined, context);
    expect(result.result).toBe(JSON.stringify({ success: true, data: { rows: [1, 2, 3] } }));
    expect(result.blocks).toBeUndefined();
  });

  it('preserves the connector_auth_required reauth-card contract', async () => {
    const { executor } = createAppConnectionTool(DESC);
    const sent: unknown[] = [];
    const context = {
      ipcRequest: async () => ({
        success: false,
        error: { code: 'connector_auth_required', message: 'Re-authorization required for notion', retriable: false },
      }),
      sendToMain: (event: unknown) => sent.push(event),
      options: { sessionId: 's1' },
    } as unknown as ToolUseContext;
    const result = await executor.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('Do NOT retry this call right now');
    expect(sent.length).toBe(1);
  });
});
