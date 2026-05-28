export const literaturePluginManifest = {
  schemaVersion: 'duya.plugin.v1',
  id: 'com.duya.literature',
  name: 'Literature Plugin',
  version: '0.1.0',
  description: 'Literature asset and evidence management for research workflows.',
  author: {
    name: 'DUYA Team',
  },
  capabilities: {
    hooks: [
      {
        event: 'research.session',
        handler: 'registerLiteratureTools',
      },
    ],
  },
  permissions: [
    { name: 'agent.memory.read', scope: 'research' },
    { name: 'agent.memory.write', scope: 'research' },
    { name: 'workspace.read' },
  ],
  engines: {
    duya: '>=0.1.0',
    node: '>=20',
  },
} as const;

