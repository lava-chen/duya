import type { AppServerTool } from './in-process-app-server.js';

/** One product capability's contribution to the host-owned app server. */
export interface AppServerCapabilityContributor {
  readonly id: string;
  readonly tools: readonly AppServerTool[];
}

/**
 * Compose capability-owned tools into one app server while catching name
 * collisions before the MCP server silently shadows a tool.
 */
export function collectAppServerTools(
  contributors: readonly AppServerCapabilityContributor[],
): AppServerTool[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const tools: AppServerTool[] = [];

  for (const contributor of contributors) {
    if (!contributor.id.trim()) throw new Error('App capability contributor requires an id.');
    if (ids.has(contributor.id)) throw new Error(`Duplicate app capability contributor: ${contributor.id}`);
    ids.add(contributor.id);

    for (const tool of contributor.tools) {
      if (!/^[A-Za-z0-9_-]+$/.test(tool.name)) {
        throw new Error(`Invalid app tool name "${tool.name}" from ${contributor.id}.`);
      }
      if (names.has(tool.name)) throw new Error(`Duplicate app tool name: ${tool.name}`);
      names.add(tool.name);
      tools.push(tool);
    }
  }

  return tools;
}
