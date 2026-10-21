import type { RuntimeToolDefinition, ToolExecutor } from './registry.js';

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
export interface ToolCatalogEntry<
  TTool extends RuntimeToolDefinition = RuntimeToolDefinition,
  TExecutor extends ToolExecutor = ToolExecutor,
> {
  toolId: string;
  internalName: string;
  definition: TTool;
  executor: TExecutor;
  exposure: ToolExposure;
  discovery: ToolDiscoveryMeta;
  source: ToolCatalogSource;
  description: string;
  schemaRevision: string;
  inputSchema: Readonly<Record<string, unknown>>;
}
