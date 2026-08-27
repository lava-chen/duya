/**
 * Tool exposure policy for MCP servers (plan 452 Phase A).
 *
 * Scope: MCP tools only. App-connector tools are deliberately OUT of scope —
 * they are always `discoverable` and @-mention-promoted per turn (the
 * user's "@ to activate" model, plan 450); the persistent Apps system
 * section covers awareness without exposure.
 *
 * MCP tools register `always` (Direct — full schema in every request) by
 * default, mirroring codex's default; the `[tools] on_demand_discovery`
 * switch flips them to `discoverable` (tool_search-only) for users who
 * prefer a lean prompt over zero-latency tool availability.
 *
 * Deliberately NOT model-capability-gated: duya targets arbitrary models
 * and its tool_search is a client-side implementation that works with any
 * function-calling model, so there is nothing to auto-detect — the choice
 * belongs to the user, not the model probe.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../hooks/config.js';

export interface ToolExposureConfig {
  /**
   * `[tools] on_demand_discovery` — when true, MCP tools register as
   * `discoverable` (surfaced only via `tool_search`). Default `false`:
   * Direct exposure, schemas ride every request. Connector (app) tools are
   * unaffected — they are always @-mention/tool_search gated.
   */
  onDemandDiscovery: boolean;
}

const DEFAULTS: ToolExposureConfig = { onDemandDiscovery: false };

export function readToolExposureConfig(configRootOverride?: string): ToolExposureConfig {
  const config: ToolExposureConfig = { ...DEFAULTS };
  try {
    const configPath = path.join(configRootOverride ?? resolveConfigRoot(), 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as { tools?: { on_demand_discovery?: unknown } };
      const flag = doc?.tools?.on_demand_discovery;
      if (typeof flag === 'boolean') config.onDemandDiscovery = flag;
    }
  } catch {
    // Config is optional — keep defaults.
  }
  // Env override for tests / headless runs.
  const env = process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  if (env !== undefined && env !== '') {
    config.onDemandDiscovery = env === '1' || env === 'true';
  }
  return config;
}
