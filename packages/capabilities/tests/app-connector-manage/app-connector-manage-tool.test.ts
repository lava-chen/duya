import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ListAppConnectorsTool,
  ConnectAppTool,
} from '../../src/AppConnectorManageTool/AppConnectorManageTool.js';
import type { AppConnectorManagementContext } from '../../src/AppConnectorManageTool/ports.js';

const catalogFixture = {
  providers: [
    { id: 'google', label: 'Google Drive', configured: true, description: 'Drive files', scopes: ['drive.readonly'] },
    { id: 'slack', label: 'Slack', configured: false, configurationHint: 'missing client id' },
  ],
  connections: [
    { id: 'conn-google', provider: 'google', accountLabel: 'me@gmail.com', status: 'connected' },
    { id: 'conn-slack', provider: 'slack', accountLabel: 'old workspace', status: 'disconnected' },
  ],
};

interface ContextOverrides {
  catalog?: unknown;
  error?: { code: string; message: string };
  omitAuthorization?: boolean;
}

function makeContext(overrides: ContextOverrides = {}) {
  const getCatalog = vi.fn(async () => {
    if (overrides.error) return { success: false, error: overrides.error };
    return { success: true, data: overrides.catalog ?? catalogFixture };
  });
  const requestAuthorization = vi.fn();
  const context: AppConnectorManagementContext = {
    toolUseId: 'tool-1',
    options: { sessionId: 'bot:abc' },
    appConnectorManagement: {
      getCatalog,
      ...(overrides.omitAuthorization ? {} : { requestAuthorization }),
    },
  };
  return { context, getCatalog, requestAuthorization };
}

type ExecResult = { id: string; name: string; result: string; error?: boolean };
const parse = (r: ExecResult) => JSON.parse(r.result) as Record<string, unknown> & { error?: string };

describe('list_app_connectors', () => {
  const tool = new ListAppConnectorsTool();

  it('projects one row per provider with merged connection state', async () => {
    const { context, getCatalog } = makeContext();
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(false);
    expect(getCatalog).toHaveBeenCalledOnce();
    const body = parse(result);
    expect(body.success).toBe(true);
    expect(body.connectors).toEqual([
      expect.objectContaining({ provider: 'google', status: 'connected', account: 'me@gmail.com' }),
      expect.objectContaining({ provider: 'slack', status: 'disconnected' }),
    ]);
    expect(result.result).not.toContain('clientSecret');
  });

  it('surfaces catalog failures as tool errors', async () => {
    const { context } = makeContext({ error: { code: 'TIMEOUT', message: 'timed out' } });
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(parse(result).error).toContain('TIMEOUT');
  });

  it('reports a missing host bridge', async () => {
    const result = await tool.execute({}, undefined, undefined);
    expect(result.error).toBe(true);
    expect(parse(result).error).toContain('main process bridge');
  });
});

describe('connect_app', () => {
  const tool = new ConnectAppTool();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a missing provider without fetching the catalog', async () => {
    const { context, getCatalog } = makeContext();
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it('rejects unknown providers with the valid id list', async () => {
    const { context } = makeContext();
    const result = await tool.execute({ provider: 'gmail' }, undefined, context);
    expect(result.error).toBe(true);
    const body = parse(result);
    expect(body.error).toContain('Unknown provider "gmail"');
    expect(body.error).toContain('google, slack');
  });

  it('short-circuits when the provider is already connected (no card)', async () => {
    const { context, requestAuthorization } = makeContext();
    const result = await tool.execute({ provider: 'google' }, undefined, context);
    expect(result.error).toBe(false);
    expect(parse(result).alreadyConnected).toBe(true);
    expect(requestAuthorization).not.toHaveBeenCalled();
  });

  it('emits the connect elicitation and instructs the model to end its turn', async () => {
    const { context, requestAuthorization } = makeContext();
    const result = await tool.execute({ provider: 'slack' }, undefined, context);
    expect(result.error).toBe(false);
    expect(parse(result).cardShown).toBe(true);
    expect(requestAuthorization).toHaveBeenCalledTimes(1);
    const event = (requestAuthorization as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(event.provider).toBe('slack');
    expect(event.variant).toBe('connect');
    expect(event.sessionId).toBe('bot:abc');
    expect(parse(result).message).toContain('END YOUR TURN');
    expect(parse(result).message).toContain('Do NOT retry');
  });

  it('reports a tool error when the authorization event bridge is missing', async () => {
    const { context } = makeContext({ omitAuthorization: true });
    const result = await tool.execute({ provider: 'slack' }, undefined, context);
    expect(result.error).toBe(true);
    expect(parse(result).error).toContain('connect card');
  });
});
