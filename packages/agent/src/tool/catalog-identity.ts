import type { Tool } from '../types.js';
import type { ToolCatalogSource } from './catalog-types.js';

// Plan 580 D1: `computeSchemaRevision` moved down into the
// protocol-pure MCP Core (`@duya/plugin-core/mcp/core/descriptor.ts`,
// canonicalize+sha256, byte-identical algorithm). This module re-exports
// it so every existing consumer (`registry.ts` snapshot revision, catalog
// tooling) keeps working; a byte-equal test in both packages locks the
//存量 registry entry hash 不变 (existing registry entry hashes do not change).
export { computeSchemaRevision as getSchemaRevision, canonicalizeJson } from '@duya/plugin-core/mcp/core/descriptor';
import { canonicalizeJson } from '@duya/plugin-core/mcp/core/descriptor';

export function normalizeToolInputSchema(schema: Tool['input_schema']): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(schema));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Tool input schema must be a JSON Schema object');
  }
  return canonicalizeJson(parsed) as Record<string, unknown>;
}

export function createToolId(source: ToolCatalogSource, rawName: string): string {
  return `${source.kind}:${encodeURIComponent(source.id)}:${encodeURIComponent(rawName)}`;
}
