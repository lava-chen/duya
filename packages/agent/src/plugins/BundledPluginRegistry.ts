import type { ToolRegistry } from '../tool/registry.js';
import type { BaseTool } from '../tool/types.js';
import { listBuiltinPlugins } from './builtin/_registry.js';
import { parsePluginMd } from './builtin/plugin-md-parser.js';
import { discoverAllCapabilities } from './builtin/capability-discovery.js';
import { join } from 'path';

export interface BundledAgentPlugin {
  id: string;
  manifest: {
    schemaVersion: string;
    id: string;
    name: string;
    version: string;
  };
  isEnabled?: () => boolean;
  createTools: () => BaseTool[];
}

export interface BuiltinPluginDescriptor {
  name: string;
  dir: string;
  metadata: {
    name: string;
    description: string;
    version: string;
    author: string;
  };
  body: string;
  capabilities: {
    commands: { name: string; path: string }[];
    agents: { name: string; path: string }[];
    skills: { name: string; path: string }[];
    hooks: { event: string; handler: string }[];
  };
}

const runtimeFactories: Record<string, () => any[]> = {
};

let _descriptorsCache: BuiltinPluginDescriptor[] | null = null;

export function listBuiltinPluginDescriptors(): BuiltinPluginDescriptor[] {
  if (_descriptorsCache) return _descriptorsCache;

  const builtins = listBuiltinPlugins();
  _descriptorsCache = builtins.map((builtin) => {
    const pluginMdPath = join(builtin.dir, 'plugin.md');
    let metadata = { name: builtin.name, description: '', version: '0.0.0', author: '' };
    let body = '';

    try {
      const result = parsePluginMd(pluginMdPath);
      metadata = result.metadata;
      body = result.body;
    } catch {
      // plugin.md is optional; fall back to directory name
    }

    const capabilities = discoverAllCapabilities(builtin.dir);

    return {
      name: builtin.name,
      dir: builtin.dir,
      metadata,
      body,
      capabilities,
    };
  });

  return _descriptorsCache;
}

export function clearBuiltinDescriptorsCache(): void {
  _descriptorsCache = null;
}

export function registerBundledAgentPlugins(
  registry: ToolRegistry,
  options?: { enabledPluginIds?: Set<string> }
): string[] {
  const registeredPluginIds: string[] = [];

  for (const descriptor of listBuiltinPluginDescriptors()) {
    if (options?.enabledPluginIds && !options.enabledPluginIds.has(descriptor.name)) {
      continue;
    }

    const factory = runtimeFactories[descriptor.name];
    if (!factory) continue;

    for (const tool of factory()) {
      registry.register(tool.toTool(), tool);
    }
    registeredPluginIds.push(descriptor.name);
  }

  return registeredPluginIds;
}

export function getBuiltinPluginDescriptor(name: string): BuiltinPluginDescriptor | undefined {
  return listBuiltinPluginDescriptors().find((p) => p.name === name);
}