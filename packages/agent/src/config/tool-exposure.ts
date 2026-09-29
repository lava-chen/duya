/**
 * Legacy MCP tool exposure setting. `full` and `hint` retain direct-call
 * availability as eager tools; `search` maps to deferred catalog dispatch.
 *
 * Scope: MCP tools only. App-connector tools are deliberately OUT of scope —
 * they are always deferred and @-mention-promoted to direct calls per turn (the
 * user's "@ to activate" model, plan 450); the persistent Apps system
 * section covers awareness without exposure.
 *
 * Compatibility mappings onto the catalog's three exposure values:
 *
 *   - `full`     → eager      full schemas ride every request.
 *   - `hint`     → eager      preserves the old direct-call behavior while
 *                             replacing the empty schema stub with its schema.
 *   - `search`   → deferred   compatibility alias for the unified catalog.
 *
 * Backward compatibility: the retired `[tools] exposure = "catalog"` value
 * is accepted and normalized to `search`; `[tools] on_demand_discovery = true`
 * maps to `search`. The explicit `exposure` key wins when both appear.
 * Env overrides mirror the config keys (DUYA_TOOLS_EXPOSURE /
 * DUYA_TOOLS_ON_DEMAND_DISCOVERY).
 *
 * The fallback catalog is client-side and works with any function-calling
 * model; native provider tool-search capabilities are negotiated separately.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../hooks/config.js';
import type { ToolExposure } from '../tool/catalog-types.js';

export type MCPExposureMode = 'full' | 'hint' | 'search';

/** Map legacy MCP configuration to the unified catalog exposure axis. */
export function mcpExposureToToolExposure(exposure: MCPExposureMode): ToolExposure {
  return exposure === 'search' ? 'deferred' : 'eager';
}

export interface ToolExposureConfig {
  /**
   * Legacy MCP policy. Default `'hint'`, mapped to eager for compatibility.
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
  // Retired plan-480 'catalog' policy: keep its deferred-schema intent.
  if (normalized === 'catalog') return 'search';
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
