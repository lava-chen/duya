// packages/plugin-core/src/mcp/shadow.ts
// Pure shadow / dedup rules for the MCP resolution engine.
//
// The only automatic dedup this round is the within-settings newest-wins
// rule (per Rev 5.1). Cross-source and cross-plugin "same server name"
// entries default to coexistence; an enabled plugin can replace a
// bundled fallback ONLY through the narrow BUILTIN_FALLBACK_REPLACEMENTS
// map (see discovery.ts).
//
// The engine is a pure function. It does not read the DB, the plugin
// registry, or `process.env`; it operates on the inventory it is given.

import type {
  MCPServerInventoryEntry,
  MCPSettingsSubOrigin,
} from './discovery';
import { findBuiltinFallbackReplacement } from './discovery';

const SETTINGS_SUBORIGIN_PRIORITY: Record<MCPSettingsSubOrigin, number> = {
  agentSettings: 3,
  settingsKv: 2,
  legacyFile: 1,
};

/**
 * Apply the within-settings newest-wins rule and the builtin-fallback
 * replacement rule. Returns a new array of inventory entries with
 * `shadowedBy` set on the losers. Pure; does not mutate the input.
 *
 * Within-settings rule:
 *   For each unscoped `serverName` that has two or three settings
 *   entries (one per sub-origin), the entry with the highest sub-origin
 *   priority (`agentSettings` > `settingsKv` > `legacyFile`) wins. The
 *   others are marked `shadowedBy` and an `mcp-server-shadowed` issue is
 *   recorded.
 *
 * Builtin-fallback rule:
 *   For each `bundled` entry, look up the matching plugin in
 *   `BUILTIN_FALLBACK_REPLACEMENTS`. If a replacement plugin entry is
 *   present in the same inventory, the bundled entry is marked
 *   `shadowedBy`. The bundled entry remains in `inventory` for
 *   visibility; it is excluded from `resolvedConfigs` by the engine.
 *
 * The function does NOT add issues directly — it returns the set of
 * `shadowedByInventoryId`s for losers. The engine attaches an
 * `mcp-server-shadowed` `MCPIssue` to each loser (see resolve.ts).
 */
export interface ShadowApplicationResult {
  /** The same inventory entries with `shadowedBy` set on the losers. */
  inventory: MCPServerInventoryEntry[];
  /**
   * One `mcp-server-shadowed` event per loser. The engine turns each
   * into a typed `MCPIssue` (with the loser's source context already
   * filled in) and appends it to the resolution result's issues.
   */
  shadowedEntries: Array<{ loser: MCPServerInventoryEntry; shadowedByInventoryId: string }>;
}

export function applySourceShadowing(
  inventory: ReadonlyArray<MCPServerInventoryEntry>,
): ShadowApplicationResult {
  const withShadow: MCPServerInventoryEntry[] = inventory.map((e) => ({ ...e }));
  const shadowedEntries: Array<{ loser: MCPServerInventoryEntry; shadowedByInventoryId: string }> = [];

  // ---- Step 1: within-settings newest-wins -------------------------------
  // Group settings entries by their unscoped server name.
  const settingsByName = new Map<string, number[]>();
  for (let i = 0; i < withShadow.length; i++) {
    const e = withShadow[i];
    if (e.source !== 'settings') continue;
    if (!e.sourceSubOrigin) continue;
    const arr = settingsByName.get(e.serverName) ?? [];
    arr.push(i);
    settingsByName.set(e.serverName, arr);
  }
  for (const [, indices] of settingsByName) {
    if (indices.length < 2) continue;
    // Pick the winner: highest SETTINGS_SUBORIGIN_PRIORITY; stable order
    // on ties by the original index.
    let winnerIndex = indices[0];
    let winnerPriority = SETTINGS_SUBORIGIN_PRIORITY[withShadow[winnerIndex].sourceSubOrigin as MCPSettingsSubOrigin];
    for (const idx of indices) {
      const p = SETTINGS_SUBORIGIN_PRIORITY[withShadow[idx].sourceSubOrigin as MCPSettingsSubOrigin];
      if (p > winnerPriority) {
        winnerIndex = idx;
        winnerPriority = p;
      }
    }
    const winnerInventoryId = withShadow[winnerIndex].inventoryId;
    for (const idx of indices) {
      if (idx === winnerIndex) continue;
      const loser = { ...withShadow[idx] };
      withShadow[idx] = { ...loser, shadowedBy: winnerInventoryId };
      shadowedEntries.push({ loser, shadowedByInventoryId: winnerInventoryId });
    }
  }

  // ---- Step 2: builtin-fallback replacement ------------------------------
  // Collect plugin inventory ids for the lookup.
  const pluginInventoryIds = new Set<string>();
  for (const e of withShadow) {
    if (e.source === 'plugin') pluginInventoryIds.add(e.inventoryId);
  }
  for (let i = 0; i < withShadow.length; i++) {
    const e = withShadow[i];
    if (e.source !== 'bundled') continue;
    const replacementPluginId = findBuiltinFallbackReplacement(
      e.serverName,
      pluginInventoryIds,
    );
    if (!replacementPluginId) continue;
    if (withShadow[i].shadowedBy === replacementPluginId) continue;
    const loser = { ...withShadow[i] };
    withShadow[i] = { ...loser, shadowedBy: replacementPluginId };
    shadowedEntries.push({ loser, shadowedByInventoryId: replacementPluginId });
  }

  return { inventory: withShadow, shadowedEntries };
}
