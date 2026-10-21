/**
 * Hook Overview IPC Client
 * Read-only wrapper for the Settings → Hooks page. Surfaces every hook the
 * agent loads (builtin loop steering policies + hook.json files registered
 * under the `[hooks] files` array),
 * grouped by trigger event.
 */

export interface HookRow {
  /** Stable id used by the Settings → Hooks toggles (`builtin.*` / `file:*`). */
  id?: string;
  /** Whether the hook currently fires (false when disabled in config). */
  enabled?: boolean;
  name: string;
  command: string;
  source: string;
  kind: 'builtin' | 'config';
  matcher?: string;
  /** Pretty-printed JSON view of the hook config (config hooks only). */
  json?: string;
}

export interface HookEventGroup {
  event: string;
  hooks: HookRow[];
}

export interface HookOverview {
  configPath: string;
  events: HookEventGroup[];
}

export interface HookWriteResult {
  ok: boolean;
  error?: string;
}

export async function getHookOverview(): Promise<HookOverview> {
  return window.electronAPI.hooks.overview();
}

/**
 * Toggle one hook's enabled state and persist it to config.toml. `true`
 * removes the id from the disabled list (the hook fires again); `false`
 * adds it. Applies on the agent's next run (hot reload).
 */
export async function setHookEnabled(
  id: string,
  enabled: boolean,
): Promise<HookWriteResult> {
  return window.electronAPI.hooks.setDisabled(id, enabled);
}
