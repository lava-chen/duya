import { PluginScope, PLUGIN_SCOPE_PRIORITY } from '../types';

export type PluginIdentifier = string;

export function resolveScopePriority(scopes: PluginScope[]): PluginScope[] {
  return [...scopes].sort(
    (a, b) => (PLUGIN_SCOPE_PRIORITY[b] ?? 0) - (PLUGIN_SCOPE_PRIORITY[a] ?? 0)
  );
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