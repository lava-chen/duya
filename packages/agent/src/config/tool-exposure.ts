/**
 * MCP tool exposure policy (four-tier exposure model).
 *
 * Scope: MCP tools only. App-connector tools are deliberately OUT of scope —
 * they are always `discoverable` and @-mention-promoted per turn (the
 * user's "@ to activate" model, plan 450); the persistent Apps system
 * section covers awareness without exposure.
 *
 * Exposure maps onto the registry's four ExposeMode tiers:
 *
 *   - `full`     → 'always'       full schemas ride every request in the
 *                                 tools array.
 *   - `hint`     → 'hint'         a stub entry (name + description +
 *                                 argument summary, empty schema) rides the
 *                                 tools array; the full schema is read via
 *                                 the constant `tool_schema` meta tool.
 *                                 DEFAULT — dynamic tools stay known to the
 *                                 model at a fraction of the token cost.
 *   - `search`   → 'discoverable' MCP tools are unknown until found via
 *                                 tool_search (schema delivered as a
 *                                 conversation-tail block; invoked via
 *                                 tool_invoke).
 *
 * Backward compatibility: the retired `[tools] exposure = "catalog"` value
 * is accepted and normalized to `hint`; `[tools] on_demand_discovery = true`
 * maps to `search`. The explicit `exposure` key wins when both appear.
 * Env overrides mirror the config keys (DUYA_TOOLS_EXPOSURE /
 * DUYA_TOOLS_ON_DEMAND_DISCOVERY).
 *
 * Deliberately NOT model-capability-gated: duya targets arbitrary models
 * and its discovery/invocation meta tools are client-side implementations
 * that work with any function-calling model, so there is nothing to
 * auto-detect — the choice belongs to the user, not the model probe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../hooks/config.js';

export type MCPExposureMode = 'full' | 'hint' | 'search';

/** Map the user-facing policy to the registry ExposeMode used by MCP tools. */
export function mcpExposureToExposeMode(
  exposure: MCPExposureMode,
): 'always' | 'hint' | 'discoverable' {
  switch (exposure) {
    case 'full':
      return 'always';
    case 'hint':
      return 'hint';
    case 'search':
      return 'discoverable';
  }
}

export interface ToolExposureConfig {
  /**
   * MCP tool exposure policy (four-tier model). Default `'hint'`.
   */
  exposure: MCPExposureMode;
  /**
   * Deprecated boolean mirror — `true` iff `exposure === 'search'`. Kept for
   * callers that predate the tier model; prefer `exposure`.
   */
  onDemandDiscovery: boolean;
}

const DEFAULTS: ToolExposureConfig = {
  exposure: 'hint',
  onDemandDiscovery: false,
};

const EXPOSURE_VALUES: readonly string[] = ['full', 'hint', 'search'];

function parseExposure(value: unknown): MCPExposureMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  // Retired plan-480 'catalog' policy: its "never a full schema on the
  // array" intent is now served by the hint tier.
  if (normalized === 'catalog') return 'hint';
  return (EXPOSURE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as MCPExposureMode)
    : undefined;
}

export function readToolExposureConfig(configRootOverride?: string): ToolExposureConfig {
  const config: ToolExposureConfig = { ...DEFAULTS };
  try {
    const configPath = path.join(configRootOverride ?? resolveConfigRoot(), 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as {
        tools?: {
          exposure?: unknown;
          on_demand_discovery?: unknown;
        };
      };
      const toolsSection = doc?.tools;
      if (toolsSection) {
        const exposure = parseExposure(toolsSection.exposure);
        if (exposure !== undefined) {
          config.exposure = exposure;
        } else if (toolsSection.on_demand_discovery === true) {
          // Legacy boolean maps to the 'search' policy.
          config.exposure = 'search';
        }
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }
  // Env overrides for tests / headless runs (new key wins over legacy key).
  const envExposure = process.env.DUYA_TOOLS_EXPOSURE;
  const envExposureMode = envExposure !== undefined && envExposure !== ''
    ? parseExposure(envExposure)
    : undefined;
  if (envExposureMode !== undefined) {
    config.exposure = envExposureMode;
  } else {
    const envLegacy = process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
    if (envLegacy !== undefined && envLegacy !== '') {
      const legacyFlag = envLegacy === '1' || envLegacy === 'true';
      if (legacyFlag) config.exposure = 'search';
    }
  }
  config.onDemandDiscovery = config.exposure === 'search';
  return config;
}
