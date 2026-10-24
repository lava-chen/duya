/** Long-lived, plugin-owned MCP runtime for a sandboxed Mini App. */
import { randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { dialog } from 'electron';
import { MCPManager } from '@duya/capabilities/MCP/MCPManager';
import type { MCPServerConfig } from '@duya/capabilities/MCP/ports';
import { buildCandidatesFromPluginEntry } from '@duya/plugin-core/mcp/collect';
import { resolveMCPDiscovery } from '@duya/plugin-core/mcp/resolve';
import { computeSchemaRevision } from '@duya/plugin-core/mcp/core/descriptor';
import { unscopedServerName } from '@duya/plugin-core';
import { pluginAppCapabilityTools, type PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import type { PluginAppInvocationResult, PluginAppResourceRead } from '@duya/agent-protocol';
import { scopedPluginServerName } from '@duya/plugin-core';
import { getPluginManager } from './PluginManager';
import { readPluginManifest } from './manifest';
import {
  getDesktopHostLocalPluginSetupApi,
  getDesktopHostPluginAppAuthority,
  getDesktopHostPluginAppGrantApi,
  getDesktopHostPluginAppInstanceApi,
} from '../cli/desktop-host-api';

export interface InstalledApp {
  pluginId: string;
  app: PluginAppDefinition;
  installPath: string;
  dataPath: string;
  revision: string;
  name: string;
}

interface BoundTool {
  toolId: string;
  toolName: string;
  serverName: string;
  schemaRevision: string;
  schema: Record<string, unknown>;
  capabilityId: string;
  validator: ValidateFunction;
}

interface AppRuntime {
  pluginId: string;
  appId: string;
  instanceId: string;
  revision: string;
  manager: MCPManager;
  tools: Map<string, BoundTool>;
  active: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const bindings = new Map<string, AppRuntime>();
const pendingStarts = new Set<Promise<unknown>>();
let shuttingDown = false;

function installedApp(pluginId: string, appId: string): InstalledApp | null {
  const entry = getPluginManager().listInstalled().find((item) => item.id === pluginId && item.enabled);
  if (!entry?.installPath || !entry.dataPath) return null;
  const manifest = readPluginManifest(entry.installPath);
  if (manifest.id !== pluginId) return null;
  const app = manifest.apps?.find((item) => item.appId === appId && item.runtime === 'standalone');
  if (!app) return null;
  return {
    pluginId, app, name: manifest.name, installPath: entry.installPath, dataPath: entry.dataPath,
    revision: JSON.stringify([entry.installPath, entry.updatedAt, manifest.version, app, manifest.capabilities.mcpServers]),
  };
}

function toMcpConfig(config: Awaited<ReturnType<typeof resolveMCPDiscovery>>['resolvedConfigs'][number]): MCPServerConfig {
  const raw = config.rawConfig;
  return {
    name: config.scopedServerName,
    source: 'plugin',
    pluginId: config.pluginId,
    ...(raw.transport === undefined ? {} : { transport: raw.transport }),
    ...(raw.command === undefined ? {} : { command: raw.command }),
    args: raw.args,
    env: raw.env,
    ...(raw.url === undefined ? {} : { url: raw.url }),
    ...(raw.headers === undefined ? {} : { headers: raw.headers }),
    ...(raw.startupTimeoutSec === undefined ? {} : { startupTimeoutSec: raw.startupTimeoutSec }),
    ...(raw.toolTimeoutSec === undefined ? {} : { toolTimeoutSec: raw.toolTimeoutSec }),
    ...(raw.toolTimeouts === undefined ? {} : { toolTimeouts: raw.toolTimeouts }),
    ...(raw.envPassthrough === undefined ? {} : { envPassthrough: raw.envPassthrough }),
    ...(raw.useShell === undefined ? {} : { useShell: raw.useShell }),
  };
}

/** Only trusted Main code calls this, before the guest page is loaded. */
export async function approveStandaloneApp(app: InstalledApp): Promise<boolean> {
  const grantApi = getDesktopHostPluginAppGrantApi();
  const currentGrants = await getDesktopHostPluginAppAuthority().resolveGrantedCapabilities({
    pluginId: app.pluginId, appId: app.app.appId, instanceId: '', sessionId: '', runId: '',
  });
  if (currentGrants === null) return false;
  const missing: Array<{ capability: string; tools: NonNullable<ReturnType<typeof pluginAppCapabilityTools>> | null }> = [];
  for (const capability of app.app.requiredCapabilities) {
    const tools = pluginAppCapabilityTools(app.app, capability);
    if (!tools) { missing.push({ capability, tools: null }); continue; }
    if (!currentGrants.includes(capability)) {
      missing.push({ capability, tools });
    }
  }
  if (missing.length === 0) return true;
  if (missing.some((item) => item.tools === null)) return false;
  const scope = missing.map(({ capability, tools }) =>
    `${capability}\n${tools!.map((tool) => `  ${tool.serverName}/${tool.toolName}`).join('\n')}`,
  ).join('\n\n');
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: `${app.name} App access`,
    message: `Allow ${app.name} to use its declared MCP tools?`,
    detail: scope,
    noLink: true,
  });
  if (response !== 0) return false;
  for (const { capability, tools } of missing) {
    await grantApi.grantPluginAppCapability({
      pluginId: app.pluginId, appId: app.app.appId, capability, tools: tools!,
    });
  }
  return true;
}

export function resolveStandaloneApp(pluginId: string, appId: string): InstalledApp | null {
  return installedApp(pluginId, appId);
}

/** Read a declared surface resource for launches without an agent worker. */
export async function readPluginUiSurfaceResource(
  pluginId: string,
  appId: string,
  server: string,
  resourceUri: string,
): Promise<PluginAppResourceRead> {
  const entry = getPluginManager().listInstalled().find((item) => item.id === pluginId && item.enabled);
  if (!entry?.installPath || !entry.dataPath) throw new Error('plugin_app_not_found');
  const manifest = readPluginManifest(entry.installPath);
  if (manifest.id !== pluginId) throw new Error('plugin_app_resource_server_mismatch');
  const app = manifest.apps?.find((item) => item.appId === appId);
  if (!app?.ui?.surfaces.some((surface) => surface.server === server && surface.resourceUri === resourceUri)) {
    throw new Error('plugin_app_surface_not_found');
  }

  const candidates = buildCandidatesFromPluginEntry({
    id: pluginId, name: manifest.name, enabled: true, installPath: entry.installPath, dataPath: entry.dataPath,
    manifest: { capabilities: manifest.capabilities },
  });
  const setup = await getDesktopHostLocalPluginSetupApi().listPluginSetupValues();
  const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  const resolved = await resolveMCPDiscovery(candidates, { environment, userConfigByPlugin: setup });
  const serverName = scopedPluginServerName(pluginId, server);
  const config = resolved.resolvedConfigs.find((item) => item.scopedServerName === serverName && item.pluginId === pluginId);
  if (!config) throw new Error('plugin_app_resource_server_unavailable');

  const manager = new MCPManager();
  try {
    const client = await manager.addServer(toMcpConfig(config));
    const liveConfig = client.getConfig();
    if (client.getName() !== serverName || client.getSource() !== 'plugin' || liveConfig.pluginId !== pluginId) {
      throw new Error('plugin_app_resource_server_mismatch');
    }
    const contents = await client.readResource(resourceUri);
    return { source: liveConfig.source ?? 'unknown', pluginId: liveConfig.pluginId, serverName, contents };
  } finally {
    await manager.disconnectAll().catch(() => undefined);
  }
}

export function bindStandaloneApp(sessionId: string, pluginId: string, appId: string, instanceId: string, launchRevision: string) {
  const task = bindStandaloneAppInternal(sessionId, pluginId, appId, instanceId, launchRevision);
  pendingStarts.add(task);
  return task.finally(() => pendingStarts.delete(task));
}

async function bindStandaloneAppInternal(sessionId: string, pluginId: string, appId: string, instanceId: string, launchRevision: string) {
  if (shuttingDown) throw new Error('plugin_app_host_stopping');
  await closeStandaloneApp(sessionId);
  const app = installedApp(pluginId, appId);
  if (!app || app.revision !== launchRevision) throw new Error('plugin_app_changed');
  const instance = await getDesktopHostPluginAppInstanceApi().getPluginAppInstance(instanceId);
  if (!instance || instance.status !== 'active' || instance.pluginId !== pluginId || instance.appId !== appId ||
      instance.stateSchemaVersion !== app.app.stateSchemaVersion) throw new Error('plugin_app_instance_unavailable');

  const manifest = readPluginManifest(app.installPath);
  const candidates = buildCandidatesFromPluginEntry({
    id: pluginId, name: app.name, enabled: true, installPath: app.installPath, dataPath: app.dataPath,
    manifest: { capabilities: manifest.capabilities },
  });
  const setup = await getDesktopHostLocalPluginSetupApi().listPluginSetupValues();
  const environment = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
  const resolved = await resolveMCPDiscovery(candidates, { environment, userConfigByPlugin: setup });
  const requiredServers = new Set((app.app.capabilityTools ?? []).flatMap((mapping) => mapping.tools.map((tool) => tool.serverName)));
  const configs = resolved.resolvedConfigs.filter((item) =>
    requiredServers.has(unscopedServerName(item.scopedServerName)));
  if (configs.length !== requiredServers.size) throw new Error('plugin_app_mcp_unavailable');
  const manager = new MCPManager();
  try {
    for (const config of configs) {
      if (shuttingDown) throw new Error('plugin_app_host_stopping');
      await manager.addServer(toMcpConfig(config));
    }
    if (shuttingDown) throw new Error('plugin_app_host_stopping');
    const authority = getDesktopHostPluginAppAuthority();
    const grants = await authority.resolveGrantedCapabilities({ pluginId, appId, instanceId, sessionId, runId: '' });
    if (grants === null) throw new Error('plugin_app_grant_authority_unavailable');
    const tools = new Map<string, BoundTool>();
    for (const config of configs) {
      const client = manager.getClient(config.scopedServerName);
      if (!client) continue;
      for (const tool of client.getTools()) {
        const capabilityId = authority.resolveToolCapability({
          pluginId, app: app.app,
          descriptor: { source: 'plugin', pluginId, serverName: config.scopedServerName, toolName: tool.name },
        });
        if (!capabilityId || !grants.includes(capabilityId)) continue;
        const schema = tool.input_schema;
        const toolId = randomUUID();
        tools.set(toolId, {
          toolId, toolName: tool.name, serverName: config.scopedServerName, capabilityId,
          schema, schemaRevision: computeSchemaRevision(schema), validator: ajv.compile(schema),
        });
      }
    }
    if (installedApp(pluginId, appId)?.revision !== launchRevision) throw new Error('plugin_app_changed');
    bindings.set(sessionId, { pluginId, appId, instanceId, revision: launchRevision, manager, tools, active: true });
    return { bindingId: sessionId, runId: null, tools: [...tools.values()].map(({ toolId, toolName }) => ({ toolId, toolName })) };
  } catch (error) {
    await manager.disconnectAll().catch(() => undefined);
    throw error;
  }
}

export async function invokeStandaloneApp(sessionId: string, toolId: string, args: Record<string, unknown>): Promise<PluginAppInvocationResult> {
  const binding = bindings.get(sessionId);
  if (!binding?.active) return { ok: false, code: 'binding_invalid', message: 'The App is not bound.' };
  const app = installedApp(binding.pluginId, binding.appId);
  if (!app || app.revision !== binding.revision) return { ok: false, code: 'plugin_app_changed', message: 'The plugin changed. Reopen the App.' };
  const instance = await getDesktopHostPluginAppInstanceApi().getPluginAppInstance(binding.instanceId);
  if (!instance || instance.status !== 'active') return { ok: false, code: 'instance_inactive', message: 'The App instance is inactive.' };
  const tool = binding.tools.get(toolId);
  if (!tool) return { ok: false, code: 'tool_unavailable', message: 'The tool is not bound to this App.' };
  const authority = getDesktopHostPluginAppAuthority();
  const grants = await authority.resolveGrantedCapabilities({
    pluginId: binding.pluginId, appId: binding.appId, instanceId: binding.instanceId, sessionId, runId: '',
  });
  const capability = authority.resolveToolCapability({
    pluginId: binding.pluginId, app: app.app,
    descriptor: { source: 'plugin', pluginId: binding.pluginId, serverName: tool.serverName, toolName: tool.toolName },
  });
  if (!grants?.includes(tool.capabilityId) || capability !== tool.capabilityId) {
    return { ok: false, code: 'capability_revoked', message: 'The App capability is no longer granted.' };
  }
  const live = binding.manager.getClient(tool.serverName)?.getTools().find((item) => item.name === tool.toolName);
  if (!live || computeSchemaRevision(live.input_schema) !== tool.schemaRevision) {
    return { ok: false, code: 'schema_changed', message: 'The tool schema changed. Reopen the App.' };
  }
  if (!tool.validator(args)) return { ok: false, code: 'invalid_arguments', message: 'Tool arguments do not match the MCP schema.' };
  if (!binding.active || bindings.get(sessionId) !== binding || installedApp(binding.pluginId, binding.appId)?.revision !== binding.revision) {
    return { ok: false, code: 'binding_invalid', message: 'The App binding was revoked before invocation.' };
  }
  const result = await binding.manager.callTool(tool.serverName, tool.toolName, args);
  return { ok: true, result };
}

export async function closeStandaloneApp(sessionId: string): Promise<void> {
  const binding = bindings.get(sessionId);
  if (!binding) return;
  binding.active = false;
  bindings.delete(sessionId);
  await binding.manager.disconnectAll().catch(() => undefined);
}

/** Stop plugin-owned processes before Desktop tears down its Host APIs. */
export async function shutdownStandaloneApps(): Promise<void> {
  shuttingDown = true;
  await Promise.allSettled([...pendingStarts]);
  await Promise.allSettled([...bindings.keys()].map((sessionId) => closeStandaloneApp(sessionId)));
}
