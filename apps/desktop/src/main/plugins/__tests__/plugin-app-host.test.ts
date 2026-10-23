import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listInstalled: vi.fn(),
  listInstances: vi.fn(),
  createInstance: vi.fn(),
  bindInvocation: vi.fn(),
  boundTools: vi.fn(),
  revokeInvocation: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
  },
}));

vi.mock('../PluginManager', () => ({
  getPluginManager: () => ({ listInstalled: mocks.listInstalled }),
}));

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostPluginAppInstanceApi: () => ({
    listPluginAppInstances: mocks.listInstances,
    createPluginAppInstance: mocks.createInstance,
  }),
  getDesktopHostPluginAppInvocationApi: () => ({
    bindPluginAppInvocation: mocks.bindInvocation,
    boundTools: mocks.boundTools,
    revokePluginAppInvocation: mocks.revokeInvocation,
  }),
}));

import { registerPluginAppHostHandlers } from '../plugin-app-host';

const PLUGIN_ID = 'com.duya.canvas';
const APP_ID = 'canvas';
const INSTANCE_ID = 'instance-1';
const CHAT_SESSION_ID = 'chat-session-1';
const APP = {
  appId: APP_ID,
  entry: 'apps/canvas/index.html',
  requiredCapabilities: ['mcp:canvas.write'],
  stateSchemaVersion: 1,
};
const INSTANCE = {
  instanceId: INSTANCE_ID,
  pluginId: PLUGIN_ID,
  appId: APP_ID,
  stateSchemaVersion: 1,
  state: {},
  revision: 1,
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
};
const BINDING = {
  bindingId: 'binding-1',
  nonce: 'opaque-binding-nonce',
  pluginId: PLUGIN_ID,
  appId: APP_ID,
  instanceId: INSTANCE_ID,
  sessionId: CHAT_SESSION_ID,
  runId: 'run-1',
  stateSchemaVersion: 1,
};
const BOUND_TOOLS = [{ toolId: 'plugin:canvas%3Acanvas:create_element', toolName: 'create_element' }];

let installPath = '';
let openedSessionId: string | undefined;

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = mocks.handlers.get(channel);
  if (!registered) throw new Error(`${channel} handler was not registered`);
  return registered;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.listInstalled.mockReset();
  mocks.listInstances.mockReset().mockResolvedValue([INSTANCE]);
  mocks.createInstance.mockReset();
  mocks.bindInvocation.mockReset().mockResolvedValue(BINDING);
  mocks.boundTools.mockReset().mockReturnValue(BOUND_TOOLS);
  mocks.revokeInvocation.mockReset().mockResolvedValue(true);
  openedSessionId = undefined;

  installPath = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'duya-plugin-app-host-'));
  const entry = path.join(installPath, ...APP.entry.split('/'));
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '<html></html>');
  const manifestPath = path.join(installPath, '.duya-plugin', 'plugin.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    id: PLUGIN_ID, name: 'canvas', version: '0.1.0',
    extensions: { 'com.duya.client': { apps: [APP] } },
  }));
  mocks.listInstalled.mockReturnValue([{
    id: PLUGIN_ID,
    enabled: true,
    installPath,
    apps: [APP],
  }]);
  registerPluginAppHostHandlers();
});

afterEach(async () => {
  if (openedSessionId) {
    await handler('plugin-app:close')(undefined, { sessionId: openedSessionId });
    openedSessionId = undefined;
  }
  if (installPath) {
    fs.rmSync(installPath, { recursive: true, force: true });
    installPath = '';
  }
});

describe('Plugin App guest bind dispatch', () => {
  it('returns only the tool descriptors from the binding through the registered production handler', async () => {
    const opened = await handler('plugin-app:open')(undefined, {
      pluginId: PLUGIN_ID,
      appId: APP_ID,
      chatSessionId: CHAT_SESSION_ID,
    }) as { ok: boolean; sessionId?: string; launchNonce?: string };
    expect(opened.ok).toBe(true);
    if (!opened.sessionId || !opened.launchNonce) throw new Error('Plugin App did not open');
    openedSessionId = opened.sessionId;

    const response = await handler('plugin-app:call')(undefined, {
      sessionId: opened.sessionId,
      launchNonce: opened.launchNonce,
      message: { method: 'bind' },
    });

    expect(mocks.bindInvocation).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      appId: APP_ID,
      instanceId: INSTANCE_ID,
      sessionId: CHAT_SESSION_ID,
    });
    expect(mocks.boundTools).toHaveBeenCalledWith(BINDING.bindingId);
    expect(response).toEqual({
      ok: true,
      result: { bindingId: BINDING.bindingId, runId: BINDING.runId, tools: BOUND_TOOLS },
    });
    expect(JSON.stringify(response)).not.toContain('mcp:canvas.write');
    expect(JSON.stringify(response)).not.toContain(BINDING.nonce);
  });
});
