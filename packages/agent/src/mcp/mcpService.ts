/**
 * packages/agent/src/mcp/mcpService.ts
 *
 * Domain reader for MCP servers. Single source of truth for the
 * CLI control plane.
 *
 * Wraps the main-process `collectMainMCPCandidates` collector and
 * applies the v0 precedence (Phase 5 lock) to produce the
 * available-skill set with stable public ids.
 *
 * Output is a strict DTO: no absolute paths, no API keys, no raw
 * settings.json paths, no internal precedence numbers.
 */

import type { MCPCandidate } from '@duya/plugin-core';

export type MCPSource = 'bundled' | 'plugin' | 'settings';

export interface MCPListItem {
  id: string;
  name: string;
  source: MCPSource;
  sourceId?: string;
  enabled: boolean;
  connected: boolean;
}

export interface MCPInfoItem extends MCPListItem {
  command: string;
  args: string[];
}

interface CollectedMCP {
  candidates: MCPCandidate[];
  issues: unknown[];
}

/**
 * Compute the public `id` for a candidate.
 */
function idFor(c: MCPCandidate): string {
  const pluginId = c.pluginId;
  if (c.source === 'plugin' && pluginId) {
    return `plugin:${pluginId}:${c.rawConfig.name}`;
  }
  if (c.source === 'bundled') {
    return `bundled:${c.rawConfig.name}`;
  }
  return `settings:${c.rawConfig.name}`;
}

/**
 * Map the source of an MCPCandidate to the v0 public source enum.
 * The raw collector uses sub-origins; we collapse to the v0 enum.
 * Note: the `MCPSource` type is the simplified public-facing type
 * ('bundled' | 'plugin' | 'settings'). The actual sub-origins
 * surface only via the `sourceSubOrigin` field on MCPCandidate.
 */
function publicSourceOf(c: MCPCandidate): MCPSource {
  if (c.source === 'bundled') return 'bundled';
  if (c.source === 'plugin') return 'plugin';
  // 'settings' covers agentSettings + settingsKv + legacyFile
  return 'settings';
}

/**
 * Resolve a single (name, source) winner. Higher precedence wins.
 * The precedence order is locked in `phase-5-mcp-source-of-truth.md`:
 *
 *   settings > plugin > bundled
 *
 * Ties broken by stable input order. Same-name candidates from
 * different sources are deduplicated; the higher-precedence source
 * wins and lower-precedence candidates are shadowed (not exposed
 * in the v0 DTO).
 */
const PRECEDENCE: Record<MCPSource, number> = {
  settings: 3,
  plugin: 2,
  bundled: 1,
};

function pickWinner(candidates: MCPCandidate[]): MCPCandidate | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = PRECEDENCE[publicSourceOf(best)];
  for (const c of candidates) {
    const score = PRECEDENCE[publicSourceOf(c)];
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Resolve all candidates into the available MCP set. One winner per
 * logical name. Shadowed candidates are NOT in the result.
 */
export function resolveAvailableMCPs(candidates: MCPCandidate[]): MCPCandidate[] {
  const byName = new Map<string, { candidate: MCPCandidate; score: number }>();
  for (const c of candidates) {
    const score = PRECEDENCE[publicSourceOf(c)];
    const existing = byName.get(c.rawConfig.name);
    if (!existing || score > existing.score) {
      byName.set(c.rawConfig.name, { candidate: c, score });
    }
  }
  return Array.from(byName.values()).map((e) => e.candidate);
}

/**
 * Build a list DTO from a collected MCP result. Applies precedence.
 */
export function toMCPListDTO(
  collected: CollectedMCP,
  connectionStatus: Record<string, boolean> = {},
): MCPListItem[] {
  const winners = resolveAvailableMCPs(collected.candidates);
  return winners.map((c) => {
    const id = idFor(c);
    const source = publicSourceOf(c);
    return {
      id,
      name: c.rawConfig.name,
      source,
      ...(source === 'plugin' && c.pluginId ? { sourceId: c.pluginId } : {}),
      enabled: c.rawConfig.allowedAgentIds !== undefined
        ? c.rawConfig.allowedAgentIds.length > 0
        : true,
      connected: connectionStatus[id] ?? false,
    };
  });
}

/**
 * Build an info DTO for a single id, or null if not found.
 */
export function toMCPInfoDTO(
  collected: CollectedMCP,
  id: string,
  connectionStatus: Record<string, boolean> = {},
): MCPInfoItem | null {
  const winners = resolveAvailableMCPs(collected.candidates);
  const found = winners.find((c) => idFor(c) === id);
  if (!found) return null;
  const list = toMCPListDTO(collected, connectionStatus).find((x) => x.id === id);
  if (!list) return null;
  return {
    ...list,
    command: found.rawConfig.command,
    args: Array.isArray(found.rawConfig.args) ? found.rawConfig.args : [],
  };
}

export { idFor as computeMCPId };