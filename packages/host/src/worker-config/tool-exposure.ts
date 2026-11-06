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
 * Default is `search`. Deferred MCP tools stay out of the request's `tools`
 * array and are reached through `tool_catalog` / `tool_invoke`, so a session
 * with many MCP servers no longer ships every tool schema on every turn —
 * the tools array is the longest stable prefix of a request, and keeping it
 * small keeps that prefix cacheable. This mirrors Codex, which always defers
 * MCP tools when tool search is available
 * (`Feature::ToolSearchAlwaysDeferMcpTools`, default enabled).
 *
 * Unlike Codex, the catalog here is client-side: `tool_catalog` and
 * `tool_invoke` are ordinary tools, so deferred discovery works on any
 * function-calling endpoint. There is no "model cannot search" blind spot —
 * a model that never discovers a deferred tool simply does not call it.
 *
 * Backward compatibility: the retired `[tools] exposure = "catalog"` value
 * is accepted and normalized to `search`; `[tools] on_demand_discovery = true`
 * maps to `search`. The explicit `exposure` key wins when both appear.
 * Env overrides mirror the config keys (DUYA_TOOLS_EXPOSURE /
 * DUYA_TOOLS_ON_DEMAND_DISCOVERY). Set `[tools] exposure = "full"` or
 * `"hint"` to restore eager MCP tools.
 *
 * Native provider tool-search capabilities are negotiated separately.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../agent-profile-config.js';

export type MCPExposureMode = 'full' | 'hint' | 'search';

/** Map legacy MCP configuration to the unified catalog exposure axis. */
export function mcpExposureToToolExposure(exposure: MCPExposureMode): 'eager' | 'deferred' {
  return exposure === 'search' ? 'deferred' : 'eager';
}

/**
 * Whether the MCP capability catalog belongs in the system prompt.
 *
 * The catalog only carries information the model cannot otherwise see: it
 * lists the MCP tools that are NOT declared on the request. Under `full`
 * and `hint` the tools ride every request with their full schema, so a
 * catalog duplicates what the request already says.
 *
 * Two call sites used to answer this differently (`=== 'search'` in the
 * session runtime, `!== 'full'` in the legacy agent shell), which made the
 * default `hint` configuration inject the catalog on one path and not the
 * other. One predicate, one answer.
 */
export function shouldInjectMcpCatalog(exposure: MCPExposureMode): boolean {
  return exposure === 'search';
}

export interface ToolExposureConfig {
  /**
   * Legacy MCP policy. Default `'search'` (deferred catalog dispatch).
   */
  exposure: MCPExposureMode;
  /**
   * Deprecated boolean mirror — `true` iff `exposure === 'search'`. Kept for
   * callers that predate the tier model; prefer `exposure`.
   */
  onDemandDiscovery: boolean;
  /**
   * Plan 448 follow-up: whether `edit` / `write` refuse to touch a file the
   * model never read. Default `true`.
   *
   * Only the "never read at all" refusal is switchable. A file that changed
   * on disk since the read is still refused — that is a data-integrity
   * check, not prompt hygiene, and turning it off would let a stale
   * old_string silently clobber someone else's change.
   */
  readFirstGate: boolean;
}

const DEFAULTS: ToolExposureConfig = {
  exposure: 'search',
  onDemandDiscovery: true,
  readFirstGate: true,
};

const EXPOSURE_VALUES: readonly string[] = ['full', 'hint', 'search'];

/** TOML booleans, plus the string spellings people write by hand / in env. */
function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  return undefined;
}

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
          read_first_gate?: unknown;
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
        const readFirstGate = parseBooleanFlag(toolsSection.read_first_gate);
        if (readFirstGate !== undefined) {
          config.readFirstGate = readFirstGate;
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
  const envReadFirstGate = parseBooleanFlag(process.env.DUYA_TOOLS_READ_FIRST_GATE);
  if (envReadFirstGate !== undefined) {
    config.readFirstGate = envReadFirstGate;
  }
  return config;
}
