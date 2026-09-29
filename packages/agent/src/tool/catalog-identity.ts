import { createHash } from 'node:crypto';

import type { Tool } from '../types.js';
import type { ToolCatalogSource } from './catalog-types.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) sorted[key] = canonicalize(child);
  }
  return sorted;
}

export function normalizeToolInputSchema(schema: Tool['input_schema']): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(schema));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Tool input schema must be a JSON Schema object');
  }
  return canonicalize(parsed) as Record<string, unknown>;
}

export function getSchemaRevision(schema: Record<string, unknown>): string {
  const serialized = JSON.stringify(canonicalize(schema));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export function createToolId(source: ToolCatalogSource, rawName: string): string {
  return `${source.kind}:${encodeURIComponent(source.id)}:${encodeURIComponent(rawName)}`;
}
