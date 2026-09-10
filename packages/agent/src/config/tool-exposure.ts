/**
 * MCP tool exposure policy (plan 452 Phase A → plan 480 §8.4).
 *
 * Scope: MCP tools only. App-connector tools are deliberately OUT of scope —
 * they are always `discoverable` and @-mention-promoted per turn (the
 * user's "@ to activate" model, plan 450); the persistent Apps system
 * section covers awareness without exposure.
 *
 * Exposure is a three-value policy (plan 480 §8.4), replacing the original
 * boolean `[tools] on_demand_discovery`:
 *
 *   - `full`    (default) MCP schemas ride every request in the tools array
 *               (Direct exposure, today's behavior).
 *   - `search`  MCP tools register `discoverable`: reachable via tool_search
 *               but not in the default tool list (old on_demand_discovery=true).
 *   - `catalog` MCP tools NEVER enter the tools array. The model discovers
 *               schemas via the constant `tool_schema` meta tool and invokes
 *               through `tool_invoke` (plan 480 — the tools array stays
 *               byte-constant for prompt-cache stability).
 *
 * Backward compatibility: `[tools] on_demand_discovery = true` maps to
 * `exposure = "search"`; the explicit `exposure` key wins when both appear.
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

export type MCPExposureMode = 'full' | 'search' | 'catalog';

/** Catalog-mode visibility guard level (plan 480 §8.3). */
export type CatalogGuardMode = 'warn' | 'enforce';

/**
 * How a tool discovered via `tool_search` gets its schema to the model
 * (plan 480 P3.2, grok `GetMcpTools` parity):
 *
 *   - `tail`  (default) the full schema is appended to the conversation tail
 *             as a transient runtime-context block; the request's `tools`
 *             array stays byte-stable (prompt-cache friendly). The model
 *             invokes the tool through the constant `tool_invoke` meta tool.
 *   - `array` (legacy plan 241) the tool is merged into the next turn's
 *             `tools` array. Kept as a configurable fallback.
 */
export type DiscoveredSchemaDelivery = 'tail' | 'array';

/** Map the user-facing policy to the registry ExposeMode used by MCP tools. */
export function mcpExposureToExposeMode(
  exposure: MCPExposureMode,
): 'always' | 'discoverable' | 'catalog' {
  switch (exposure) {
    case 'full':
      return 'always';
    case 'search':
      return 'discoverable';
    case 'catalog':
      return 'catalog';
  }
}

export interface ToolExposureConfig {
  /**
   * MCP tool exposure policy (plan 480 §8.4). Default `'full'`.
   */
  exposure: MCPExposureMode;
  /**
   * Deprecated boolean mirror — `true` iff `exposure === 'search'`. Kept for
   * callers that predate the three-value policy; prefer `exposure`.
   */
  onDemandDiscovery: boolean;
  /**
   * Visibility guard level under `exposure = 'catalog'` (plan 480 §8.3):
   *   'warn'    (default) direct calls to undeclared tools execute but are
   *             counted/logged (compliance measurement);
   *   'enforce' direct calls are rejected with a structured message pointing
   *             the model at tool_schema → tool_invoke (grok's hard harness).
   * `[tools] catalog_guard = "warn"|"enforce"`; env DUYA_CATALOG_GUARD.
   */
  catalogGuard: CatalogGuardMode;
  /**
   * Discovered-tool schema delivery (plan 480 P3.2). Default `'tail'`.
   * `[tools] discovered_schema = "tail"|"array"`; env
   * DUYA_TOOLS_DISCOVERED_SCHEMA.
   */
  discoveredSchemaDelivery: DiscoveredSchemaDelivery;
}

const DEFAULTS: ToolExposureConfig = {
  exposure: 'full',
  onDemandDiscovery: false,
  catalogGuard: 'warn',
  discoveredSchemaDelivery: 'tail',
};

const DELIVERY_VALUES: readonly DiscoveredSchemaDelivery[] = ['tail', 'array'];

function parseDelivery(value: unknown): DiscoveredSchemaDelivery | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (DELIVERY_VALUES as readonly string[]).includes(normalized)
    ? (normalized as DiscoveredSchemaDelivery)
    : undefined;
}

const GUARD_VALUES: readonly CatalogGuardMode[] = ['warn', 'enforce'];

function parseGuard(value: unknown): CatalogGuardMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (GUARD_VALUES as readonly string[]).includes(normalized)
    ? (normalized as CatalogGuardMode)
    : undefined;
}

const EXPOSURE_VALUES: readonly MCPExposureMode[] = ['full', 'search', 'catalog'];

function parseExposure(value: unknown): MCPExposureMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
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
          catalog_guard?: unknown;
          discovered_schema?: unknown;
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
        const guard = parseGuard(toolsSection.catalog_guard);
        if (guard !== undefined) config.catalogGuard = guard;
        const delivery = parseDelivery(toolsSection.discovered_schema);
        if (delivery !== undefined) config.discoveredSchemaDelivery = delivery;
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }
  // Env overrides for tests / headless runs (new key wins over legacy key).
  const envGuard = process.env.DUYA_CATALOG_GUARD;
  const envGuardMode =
    envGuard !== undefined && envGuard !== '' ? parseGuard(envGuard) : undefined;
  if (envGuardMode !== undefined) config.catalogGuard = envGuardMode;

  const envExposure = process.env.DUYA_TOOLS_EXPOSURE;
  const envExposureMode = envExposure !== undefined && envExposure !== ''
    ? parseExposure(envExposure)
    : undefined;
  const envDelivery = process.env.DUYA_TOOLS_DISCOVERED_SCHEMA;
  const envDeliveryMode =
    envDelivery !== undefined && envDelivery !== ''
      ? parseDelivery(envDelivery)
      : undefined;
  if (envDeliveryMode !== undefined) {
    config.discoveredSchemaDelivery = envDeliveryMode;
  }

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
