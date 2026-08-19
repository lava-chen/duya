/**
 * Hook Overview IPC Client
 * Read-only wrapper for the Settings → Hooks page. Surfaces every hook the
 * agent loads (builtin loop steering policies + hook.json files registered
 * under the `[hooks] files` array),
 * grouped by trigger event.
 */

export interface HookRow {
  name: string;
  command: string;
  source: string;
  kind: 'builtin' | 'config';
  matcher?: string;
}

export interface HookEventGroup {
  event: string;
  hooks: HookRow[];
}

export interface HookOverview {
  configPath: string;
  events: HookEventGroup[];
}

export async function getHookOverview(): Promise<HookOverview> {
  return window.electronAPI.hooks.overview();
}