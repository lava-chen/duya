import { describe, expect, it, vi } from 'vitest';
import { createAppConnectionTool, type AppConnectionToolDescriptor } from '../index.js';
import type { ToolUseContext } from '../../../types.js';

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

function makeContext(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    ipcRequest: vi.fn(),
    sendToMain: vi.fn(),
    options: { sessionId: 'sess-1' },
    ...overrides,
  } as unknown as ToolUseContext;
}

describe('AppConnectionTool executor error guidance (plan 498)', () => {
  it('emits chat:connector_auth_required to main with session context', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const context = makeContext();
    (context.ipcRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: { code: 'connector_auth_required', message: 'token expired' },
    });

    await executor.execute({ title: 'x' }, undefined, context);

    expect(context.sendToMain).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat:connector_auth_required',
        sessionId: 'sess-1',
        toolName: 'notion_create_page',
        provider: 'notion',
        connectionId: 'conn-1',
      }),
    );
  });

  it('guides the model to end its turn instead of retrying on connector_auth_required', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const context = makeContext();
    (context.ipcRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: { code: 'connector_auth_required', message: 'token expired' },
    });

    const result = await executor.execute({}, undefined, context);

    expect(result.error).toBe(true);
    const payload = JSON.parse(result.result) as { error: { message: string } };
    expect(payload.error.message).toContain('re-authorization card for notion has been shown');
    expect(payload.error.message).toContain('end your turn');
    expect(payload.error.message).not.toContain('the user may need to reconnect');
  });

  it('keeps the reconnect hint for other connection error codes', async () => {
    const { executor } = createAppConnectionTool(makeDescriptor());
    const context = makeContext();
    (context.ipcRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: { code: 'connection_revoked', message: 'revoked' },
    });

    const result = await executor.execute({}, undefined, context);
    const payload = JSON.parse(result.result) as { error: { message: string } };
    expect(payload.error.message).toContain('the user may need to reconnect the notion account');
    expect(context.sendToMain).not.toHaveBeenCalled();
  });
});
