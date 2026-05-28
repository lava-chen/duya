import type { PluginCatalogEntry } from './types';

export const BUNDLED_PLUGIN_CATALOG: PluginCatalogEntry[] = [
  {
    id: 'com.duya.literature',
    name: 'Literature Plugin',
    version: '0.1.0',
    description: 'Literature asset and evidence management for research workflows.',
    source: 'bundled',
    trustLevel: 'official',
    manifest: {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.literature',
      name: 'Literature Plugin',
      version: '0.1.0',
      description: 'Literature asset and evidence management for research workflows.',
      author: { name: 'DUYA Team' },
      capabilities: {
        hooks: [{ event: 'research.session', handler: 'registerLiteratureTools' }],
      },
      permissions: [
        { name: 'agent.memory.read', scope: 'research' },
        { name: 'agent.memory.write', scope: 'research' },
        { name: 'workspace.read' },
      ],
      engines: { duya: '>=0.1.0', node: '>=20' },
    },
  },
  {
    id: 'com.duya.devtools',
    name: 'DevTools Plus',
    version: '0.1.0',
    description: 'Developer helpers with MCP server and CLI tools.',
    source: 'bundled',
    trustLevel: 'official',
    manifest: {
      schemaVersion: 'duya.plugin.v1',
      id: 'com.duya.devtools',
      name: 'DevTools Plus',
      version: '0.1.0',
      description: 'Developer helpers with MCP server and CLI tools.',
      author: { name: 'DUYA Team' },
      capabilities: {
        mcpServers: [
          {
            name: 'devtools',
            command: 'node',
            args: ['./dist/mcp-server.js'],
          },
        ],
        cli: [
          {
            name: 'devtools',
            command: './bin/devtools',
          },
        ],
      },
      permissions: [
        { name: 'workspace.read' },
        { name: 'workspace.write' },
      ],
      engines: { duya: '>=0.1.0' },
    },
  },
];

export function getPluginCatalog(): PluginCatalogEntry[] {
  return BUNDLED_PLUGIN_CATALOG;
}

export function getPluginCatalogEntry(id: string): PluginCatalogEntry | undefined {
  return BUNDLED_PLUGIN_CATALOG.find((entry) => entry.id === id);
}
