import { describe, expect, it, vi } from 'vitest';
import { createHostPluginAppInvocationApi } from '../src/local-plugin-app-invocation-api.js';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';

const CAPABILITY = 'mcp:canvas.write';
const TOOL_NAME = 'create_element';
const TOOL_ID = 'plugin:canvas%3Acanvas:create_element';

const APP: PluginAppDefinition = {
  appId: 'canvas',
  entry: 'apps/canvas/index.html',
  requiredCapabilities: [CAPABILITY],
  stateSchemaVersion: 1,
};

const INSTANCE = {
  instanceId: 'instance-1',
  pluginId: 'com.duya.canvas',
  appId: 'canvas',
  stateSchemaVersion: 1,
  state: {},
  revision: 1,
  status: 'active' as const,
  createdAt: 0,
  updatedAt: 0,
};

function createApi(options: { granted?: readonly string[] | null } = {}) {
  return createHostPluginAppInvocationApi({
    getInstance: async (instanceId) => (instanceId === INSTANCE.instanceId ? INSTANCE : null),
    authority: {
      resolveApp: async () => APP,
      resolveGrantedCapabilities: async () =>
        options.granted === undefined ? [CAPABILITY] : options.granted,
      resolveToolCapability: () => CAPABILITY,
    },
    worker: {
      describeMcpTools: async () => [
        {
          toolId: TOOL_ID,
          schemaRevision: 'rev-1',
          descriptor: { source: 'plugin', serverName: 'canvas', toolName: TOOL_NAME },
        },
      ],
      invokeMcpTool: async () => ({ ok: true, result: { ok: true } }),
    },
    currentRun: async () => ({ runId: 'run-1', epoch: 1 }),
    isCurrentRun: async () => true,
  });
}

describe('boundTools', () => {
  it('reports the tools a live binding covers, by catalog id and MCP tool name', async () => {
    const api = createApi();
    const binding = await api.bindPluginAppInvocation({
      pluginId: INSTANCE.pluginId,
      appId: INSTANCE.appId,
      instanceId: INSTANCE.instanceId,
      sessionId: 'session-1',
    });

    expect(api.boundTools(binding.bindingId)).toEqual([{ toolId: TOOL_ID, toolName: TOOL_NAME }]);
  });

  it('is empty for a binding that does not exist', async () => {
    const api = createApi();
    expect(api.boundTools('no-such-binding')).toEqual([]);
  });

  it('is empty when the grant covers no capability, so the binding carries no tool', async () => {
    const api = createApi({ granted: [] });
    const binding = await api.bindPluginAppInvocation({
      pluginId: INSTANCE.pluginId,
      appId: INSTANCE.appId,
      instanceId: INSTANCE.instanceId,
      sessionId: 'session-1',
    });

    expect(api.boundTools(binding.bindingId)).toEqual([]);
  });

  it('does not leak the tool set through the public binding shape', async () => {
    const api = createApi();
    const binding = await api.bindPluginAppInvocation({
      pluginId: INSTANCE.pluginId,
      appId: INSTANCE.appId,
      instanceId: INSTANCE.instanceId,
      sessionId: 'session-1',
    });

    expect(Object.keys(binding)).not.toContain('tools');
    expect(Object.keys(binding)).not.toContain('grantedCapabilities');
  });
});

describe('boundTools liveness', () => {
  it('is empty after a binding expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const api = createApi();
      const binding = await api.bindPluginAppInvocation({
        pluginId: INSTANCE.pluginId,
        appId: INSTANCE.appId,
        instanceId: INSTANCE.instanceId,
        sessionId: 'session-expired',
      });

      now.mockReturnValue(301_000);
      expect(api.boundTools(binding.bindingId)).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it('is empty after the binding is revoked', async () => {
    const api = createApi();
    const binding = await api.bindPluginAppInvocation({
      pluginId: INSTANCE.pluginId,
      appId: INSTANCE.appId,
      instanceId: INSTANCE.instanceId,
      sessionId: 'session-revoked',
    });

    expect(await api.revokePluginAppInvocation(binding.bindingId, binding.nonce)).toBe(true);
    expect(api.boundTools(binding.bindingId)).toEqual([]);
  });
});
