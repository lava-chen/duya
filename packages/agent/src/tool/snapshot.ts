// packages/agent/src/tool/snapshot.ts
//
// Plan 314: ToolSnapshot — an immutable per-turn view of the
// long-lived ToolCatalog. Built once at the start of each
// `streamChat` via `ToolRegistry.snapshot()`. The snapshot captures
// the tools, executors, metadata, and the providerName→internalKey
// alias map at a single point in time, so the streaming loop and
// the visibility filter see a consistent set even if the catalog
// is mutated mid-turn (e.g. by `tools/list_changed`).
//
// Design notes:
//   - `tools` is a frozen array; callers must not mutate it.
//   - Lookup helpers (`getExposure`, `getExecutor`, `getMeta`)
//     key on `definition.name` (the model-visible name), NOT on the
//     registry's internal storage key. This is correct for both
//     builtin tools (key === name) and MCP tools (key ===
//     internalKey, name === providerName).
//   - `providerNameToInternalKey` is the alias map that
//     `StreamingToolExecutor` consumes via
//     `resolveMCPProviderToolName`.

import type { Tool } from '../types.js';
import type { ToolExecutor, ToolHintMeta } from './registry.js';
import type { ToolCatalogEntry, ToolExposure } from './catalog-types.js';

/**
 * Immutable per-turn view of the ToolCatalog.
 *
 * Created by `ToolRegistry.snapshot()`. All lookup helpers key on
 * `definition.name` (the model-visible tool name).
 */
export interface ToolSnapshot {
  /** All tool definitions visible this turn (builtin + mcp + plugin + app-connection). */
  readonly tools: ReadonlyArray<Tool>;
  /** providerName → internalKey alias map (StreamingToolExecutor dependency). */
  readonly providerNameToInternalKey: ReadonlyMap<string, string>;
  /** Canonical exposure mode by model-visible tool name. */
  getExposure(name: string): ToolExposure;
  /** Look up executor by tool name. */
  getExecutor(name: string): ToolExecutor | undefined;
  /** Look up persisted meta by tool name. */
  getMeta(name: string): ToolHintMeta | undefined;
  /** Read-only catalog rows from the same immutable turn snapshot. */
  readonly catalogEntries: ReadonlyArray<ToolCatalogEntry>;
  /** Resolve one row by its stable tool ID. */
  getCatalogEntry(toolId: string): ToolCatalogEntry | undefined;
  /**
   * Plan 580 D10: catalog revision captured when the snapshot was
   * taken. `tool_catalog` list-mode cursors encode it so a pagination
   * run that overlaps an inventory refresh fails loudly
   * (`CATALOG_CURSOR_STALE`) instead of returning duplicated or
   * skipped rows.
   */
  readonly catalogRevision: number;
  /** Creation timestamp (ms since epoch) for diagnostics. */
  readonly createdAt: number;
}
