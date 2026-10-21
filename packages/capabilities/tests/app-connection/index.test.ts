import { describe, expect, it, vi } from 'vitest';
import { createAppConnectionTool, type AppConnectionToolDescriptor } from '../../src/AppConnectionTool/index.js';
import type { AppConnectionToolContext } from '../../src/AppConnectionTool/ports.js';

function makeDescriptor(overrides: Partial<AppConnectionToolDescriptor> = {}): AppConnectionToolDescriptor {
  return {
    name: 'notion_create_page',
    description: 'Create a Notion page',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaSummary: 'create a page',
    riskTier: 'write',
    provider: 'notion',
    connectionId: 'conn-1',
    action: 'create_page',
    ...overrides,
  };
}

function makeContext(response: unknown): AppConnectionToolContext {
  return {
    toolUseId: 'tool-1',
    options: { sessionId: 'sess-1' },
    appConnection: {
      invoke: vi.fn().mockResolvedValue(response),
      requestReauthorization: vi.fn(),
    },
  };
}

describe('AppConnectionTool executor error guidance (plan 498)', () => {
  it('emits the reauthorization request with session context', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const context = makeContext({
      success: false,
      error: { code: 'connector_auth_required', message: 'token expired' },
    });

    await executor.execute({ title: 'x' }, undefined, context);

    expect(context.appConnection?.requestReauthorization).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      toolName: 'notion_create_page',
      provider: 'notion',
      connectionId: 'conn-1',
      variant: 'reauth',
    });
  });

  it('guides the model to end its turn instead of retrying on connector_auth_required', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const result = await executor.execute({}, undefined, makeContext({
      success: false,
      error: { code: 'connector_auth_required', message: 'token expired' },
    }));

    expect(result.error).toBe(true);
    const payload = JSON.parse(result.result) as { error: { message: string } };
    expect(payload.error.message).toContain('re-authorization card for notion has been shown');
    expect(payload.error.message).toContain('end your turn');
    expect(payload.error.message).not.toContain('the user may need to reconnect');
  });

  it('keeps the reconnect hint for other connection error codes', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const context = makeContext({
      success: false,
      error: { code: 'connection_revoked', message: 'revoked' },
    });

    const result = await executor.execute({}, undefined, context);
    const payload = JSON.parse(result.result) as { error: { message: string } };
    expect(payload.error.message).toContain('the user may need to reconnect the notion account');
    expect(context.appConnection?.requestReauthorization).not.toHaveBeenCalled();
  });

  it('returns the established NO_IPC envelope without a host port', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const result = await executor.execute({}, undefined, undefined);
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result)).toMatchObject({ error: { code: 'NO_IPC' } });
  });
});
