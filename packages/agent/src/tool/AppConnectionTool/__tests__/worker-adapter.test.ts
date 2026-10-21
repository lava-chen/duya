import { describe, expect, it, vi } from 'vitest';
import type { ToolUseContext } from '../../../types.js';
import { ToolRegistry } from '../../registry.js';
import {
  createAppConnectionTool,
  registerAppConnectionTools,
  type AppConnectionToolDescriptor,
} from '../index.js';
import { ConnectAppTool, ListAppConnectorsTool } from '../../AppConnectorManageTool/AppConnectorManageTool.js';

const descriptor: AppConnectionToolDescriptor = {
  name: 'remote_notion_search',
  description: 'Search Notion',
  inputSchema: { type: 'object', properties: {} },
  inputSchemaSummary: 'Search pages',
  riskTier: 'read',
  provider: 'notion',
  connectionId: 'conn-1',
  action: 'remote:search',
};

function toolContext(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    toolUseId: 'tool-1',
    getAppState: () => ({}),
    setAppState: (update) => update({}),
    abortController: new AbortController(),
    options: { sessionId: 'session-1' },
    ...overrides,
  };
}

describe('Agent connector compatibility adapters', () => {
  it('routes capability invocation through the established worker IPC contract', async () => {
    const ipcRequest = vi.fn(async () => ({ success: true, data: { result: 'ok' } }));
    const { executor } = createAppConnectionTool(descriptor);
    await executor.execute({}, undefined, toolContext({ ipcRequest }));

    expect(ipcRequest).toHaveBeenCalledWith(
      'appConnection:invoke',
      expect.objectContaining({ connectionId: 'conn-1', action: 'remote:search' }),
      { timeout: 150_000 },
    );
  });

  it('keeps connector replace-set ownership in the runtime registry', () => {
    const registry = new ToolRegistry();
    registerAppConnectionTools(registry, [descriptor]);
    expect(registry.getOwner(descriptor.name)).toBe('connector:conn-1');
    expect(registry.getMeta(descriptor.name)?.exposure).toBe('deferred');
  });

  it('routes connector catalog reads and authorization events through worker bridges', async () => {
    const catalog = {
      providers: [{ id: 'slack', label: 'Slack', configured: true }],
      connections: [],
    };
    const ipcRequest = vi.fn(async () => ({ success: true, data: catalog }));
    const listResult = await new ListAppConnectorsTool().execute({}, undefined, toolContext({ ipcRequest }));
    expect(listResult.error).toBe(false);
    expect(ipcRequest).toHaveBeenCalledWith('appConnection:catalog', {}, { timeout: 15_000 });

    const sendToMain = vi.fn();
    await new ConnectAppTool().execute(
      { provider: 'slack' },
      undefined,
      toolContext({ ipcRequest, sendToMain }),
    );
    expect(sendToMain).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:connector_auth_required',
      sessionId: 'session-1',
      provider: 'slack',
      variant: 'connect',
    }));
  });
});
