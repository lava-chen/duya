import type { Tool } from '../types.js';
import type { ToolExecutor } from './registry.js';

export type ToolExposure = 'eager' | 'deferred' | 'hidden';

export type ToolSourceKind = 'builtin' | 'mcp' | 'plugin' | 'connector';

export interface ToolCatalogSource {
  kind: ToolSourceKind;
  id: string;
}

export interface ToolDiscoveryMeta {
  namespace: string;
  conciseHint: string;
  tags: readonly string[];
}

/** Internal immutable catalog row captured by a ToolSnapshot. */
export interface ToolCatalogEntry {
  toolId: string;
  internalName: string;
  definition: Tool;
  executor: ToolExecutor;
  exposure: ToolExposure;
  discovery: ToolDiscoveryMeta;
  source: ToolCatalogSource;
  description: string;
  schemaRevision: string;
  inputSchema: Readonly<Record<string, unknown>>;
}
