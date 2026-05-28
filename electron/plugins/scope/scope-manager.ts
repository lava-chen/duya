import { PluginScope, PLUGIN_SCOPE_PRIORITY } from '../types';
import type { InstalledPluginInfoV2 } from '../types';

export type PluginIdentifier = string;

export interface ScopeResolution {
  scope: PluginScope;
  plugins: Map<PluginIdentifier, InstalledPluginInfoV2>;
}

export function resolveScopePriority(scopes: PluginScope[]): PluginScope[] {
  return [...scopes].sort(
    (a, b) => (PLUGIN_SCOPE_PRIORITY[b] ?? 0) - (PLUGIN_SCOPE_PRIORITY[a] ?? 0)
  );
}

export function getEffectivePlugin(
  pluginId: string,
  allPlugins: Record<string, InstalledPluginInfoV2>
): InstalledPluginInfoV2 | null {
  const entries = Object.values(allPlugins).filter((p) => {
    const key = Object.keys(allPlugins).find((k) => allPlugins[k] === p);
    return key === pluginId;
  });

  if (entries.length === 0) return null;

  const sorted = entries.sort(
    (a, b) =>
      (PLUGIN_SCOPE_PRIORITY[b.scope] ?? 0) -
      (PLUGIN_SCOPE_PRIORITY[a.scope] ?? 0)
  );

  return sorted[0];
}

export function getScopeOverride(
  pluginId: string,
  scopes: PluginScope[],
  allPlugins: Record<string, InstalledPluginInfoV2>
): { effective: InstalledPluginInfoV2; overridden: InstalledPluginInfoV2[] } | null {
  const sortedScopes = resolveScopePriority(scopes);
  const candidates: InstalledPluginInfoV2[] = [];

  for (const [key, info] of Object.entries(allPlugins)) {
    if (key === pluginId && sortedScopes.includes(info.scope)) {
      candidates.push(info);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      (PLUGIN_SCOPE_PRIORITY[b.scope] ?? 0) -
      (PLUGIN_SCOPE_PRIORITY[a.scope] ?? 0)
  );

  return {
    effective: candidates[0],
    overridden: candidates.slice(1),
  };
}

export function groupByScope(
  plugins: Record<string, InstalledPluginInfoV2>
): Map<PluginScope, InstalledPluginInfoV2[]> {
  const groups = new Map<PluginScope, InstalledPluginInfoV2[]>();

  for (const info of Object.values(plugins)) {
    const group = groups.get(info.scope) ?? [];
    group.push(info);
    groups.set(info.scope, group);
  }

  return groups;
}

export function getScopeLabel(scope: PluginScope): string {
  switch (scope) {
    case PluginScope.Managed:
      return 'Managed (IT Policy)';
    case PluginScope.User:
      return 'User';
    case PluginScope.Project:
      return 'Project';
    case PluginScope.Local:
      return 'Local Dev';
    case PluginScope.Builtin:
      return 'Built-in';
  }
}

export function getScopeDescription(scope: PluginScope): string {
  switch (scope) {
    case PluginScope.Managed:
      return 'Locked by enterprise IT policy. Cannot be modified by user.';
    case PluginScope.User:
      return 'Installed globally for current user.';
    case PluginScope.Project:
      return 'Installed in .duya/plugins/ directory for this project only.';
    case PluginScope.Local:
      return 'Local development plugin loaded via --plugin-dir flag.';
    case PluginScope.Builtin:
      return 'Built-in plugin bundled with DUYA.';
  }
}

export function canUserModify(scope: PluginScope): boolean {
  return scope !== PluginScope.Managed;
}

export function isAutoUpdateAllowed(
  scope: PluginScope,
  policyScopes: PluginScope[]
): boolean {
  return policyScopes.includes(scope);
}