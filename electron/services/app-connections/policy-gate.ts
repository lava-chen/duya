/**
 * App-connection exposure-layer policy (Plan 450 Phase C).
 *
 * Codex parity: `core/src/connectors/src/app_tool_policy.rs` `AppToolPolicy`.
 * Reads `[apps]` from config and answers "is this provider enabled?" for the
 * exposure layer. Operates before descriptor emission, so a disabled
 * provider's tools do not enter the agent's registry at all — aligned
 * with codex's gating order (`apps_enabled ? filter_codex_apps_mcp_tools :
 * empty`).
 *
 * Storage choice: `AppEntry { enabled: boolean }` already exists in
 * config schema (reserved decision 17); Plan 450 finally wires it. Default
 * is `{}` (every provider enabled) so existing users see no behavior
 * change until they set a value.
 */

import { getConfigStore } from '../../config/store-instance';

const CONFIG_KEY = 'apps';

export interface AppPolicy {
  /** Explicit per-provider overrides; missing key = default. */
  perProvider: Record<string, { enabled: boolean }>;
}

/**
 * Resolve the effective enabled-state for one provider. Pure function
 * over a snapshot of the config so callers can cache / pre-compute
 * without re-reading the store.
 *
 *   - Entry present + `enabled: false`  → disabled.
 *   - Entry present + `enabled: true`   → enabled.
 *   - Entry absent                       → default = enabled (opt-in
 *     stance; disabling is explicit).
 */
export function isProviderEnabled(policy: AppPolicy, providerId: string): boolean {
  const entry = policy.perProvider[providerId];
  if (entry === undefined) return true;
  return entry.enabled !== false;
}

/** Snapshot the live `[apps]` config into a normalized policy shape. */
export function readAppPolicy(): AppPolicy {
  const raw = getConfigStore().getByPath(CONFIG_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { perProvider: {} };
  // Each entry is expected to be `{ enabled: boolean }`. Anything
  // malformed falls back to "enabled" (the default-allow stance).
  const out: Record<string, { enabled: boolean }> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entry = (v as Record<string, unknown>);
      if (typeof entry.enabled === 'boolean') {
        out[k] = { enabled: entry.enabled };
      }
    }
  }
  return { perProvider: out };
}

/** Convenience wrapper that fetches a fresh snapshot then answers. */
export function isProviderEnabledLive(providerId: string): boolean {
  return isProviderEnabled(readAppPolicy(), providerId);
}

// Plan 583 / ISS-19: `setProviderEnabled` is gone. Nothing ever called it —
// there is no UI or IPC surface for it — so the `[apps]` policy was only ever
// reachable by hand-editing config.toml, and the export made that read as a
// supported write path. The gate is still enforced (now on the invoke path
// too); changing it is a config edit. If a product decision later calls for an
// app-managed toggle, it should ship with the settings surface that needs it,
// rather than as a bare setter nobody renders.