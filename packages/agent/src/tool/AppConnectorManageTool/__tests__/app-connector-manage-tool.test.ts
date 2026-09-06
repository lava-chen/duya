/**
 * App Connector Management Tool tests (Plan 502).
 *
 * Covers the bot-only connector elicitation contract:
 *   - list_app_connectors: compact per-provider projection from the
 *     catalog DTO (no tokens cross the boundary).
 *   - connect_app: unknown provider rejection, already-connected short
 *     circuit, and the elicitation path (sendToMain variant 'connect' +
 *     end-turn instruction). The OAuth flow itself stays in main/UI.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  ListAppConnectorsTool,
  ConnectAppTool,
} from '../AppConnectorManageTool.js';

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
  ipcError?: { code: string; message: string };
  sendToMain?: (msg: Record<string, unknown>) => void;
  omitSendToMain?: boolean;
}

function makeContext(overrides: ContextOverrides = {}) {
  const sendToMain = overrides.sendToMain ?? vi.fn();
  const ipcRequest = vi.fn(async () => {
    if (overrides.ipcError) {
      return { success: false, error: overrides.ipcError };
    }
    return { success: true, data: overrides.catalog ?? catalogFixture };
  });
  return {
    context: {
      ipcRequest,
      ...(overrides.omitSendToMain ? {} : { sendToMain }),
      options: { sessionId: 'bot:abc' },
    } as never,
    ipcRequest,
    sendToMain,
  };
}

type ExecResult = { id: string; name: string; result: string; error?: boolean };
const parse = (r: ExecResult) => JSON.parse(r.result) as Record<string, unknown> & { error?: string };

describe('list_app_connectors', () => {
  const tool = new ListAppConnectorsTool();

  it('projects one row per provider with merged connection state', async () => {
    const { context, ipcRequest } = makeContext();
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(false);
    expect(ipcRequest).toHaveBeenCalledWith('appConnection:catalog', {}, { timeout: 15_000 });
    const body = parse(result);
    expect(body.success).toBe(true);
    expect(body.connectors).toEqual([
      expect.objectContaining({ provider: 'google', status: 'connected', account: 'me@gmail.com' }),
      expect.objectContaining({ provider: 'slack', status: 'disconnected' }),
    ]);
    // Secrets never appear in the projection.
    expect(result.result).not.toContain('clientSecret');
  });

  it('surfaces IPC failures as tool errors', async () => {
    const { context } = makeContext({ ipcError: { code: 'TIMEOUT', message: 'timed out' } });
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(parse(result).error).toContain('TIMEOUT');
  });
});

describe('connect_app', () => {
  const tool = new ConnectAppTool();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a missing provider without any IPC round-trip', async () => {
    const { context, ipcRequest } = makeContext();
    const result = await tool.execute({}, undefined, context);
    expect(result.error).toBe(true);
    expect(ipcRequest).not.toHaveBeenCalled();
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
    const { context, sendToMain } = makeContext();
    const result = await tool.execute({ provider: 'google' }, undefined, context);
    expect(result.error).toBe(false);
    const body = parse(result);
    expect(body.alreadyConnected).toBe(true);
    expect(sendToMain).not.toHaveBeenCalled();
  });

  it('emits the connect elicitation and instructs the model to end its turn', async () => {
    const sendToMain = vi.fn();
    const { context } = makeContext({ sendToMain });
    const result = await tool.execute({ provider: 'slack' }, undefined, context);
    expect(result.error).toBe(false);
    expect(parse(result).cardShown).toBe(true);
    expect(sendToMain).toHaveBeenCalledTimes(1);
    const event = (sendToMain as Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(event.type).toBe('chat:connector_auth_required');
    expect(event.provider).toBe('slack');
    expect(event.variant).toBe('connect');
    expect(event.sessionId).toBe('bot:abc');
    // grok AuthenticateMcpServer contract: no retry, no links, end turn.
    expect(parse(result).message).toContain('END YOUR TURN');
    expect(parse(result).message).toContain('Do NOT retry');
  });

  it('reports a tool error when the main bridge is missing', async () => {
    const { context } = makeContext({ omitSendToMain: true });
    const result = await tool.execute({ provider: 'slack' }, undefined, context);
    expect(result.error).toBe(true);
    const body = parse(result);
    expect(body.error).toContain('connect card');
  });
});
