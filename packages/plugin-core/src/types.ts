// ============================================================================
// @duya/plugin-core types — Mirrored from src/lib/plugin-error-types.ts
// for use in Electron/Node.js context
// ============================================================================

export type PluginInstallError =
  | { type: 'git-auth-failed'; plugin: string; path: string; reason: string }
  | { type: 'git-timeout'; plugin: string; path: string; duration: number }
  | { type: 'git-clone-failed'; plugin: string; path: string; message: string }
  | { type: 'network-error'; plugin?: string; url: string; statusCode?: number; message: string; retryable: boolean }
  | { type: 'npm-install-failed'; plugin: string; package: string; message: string }
  | { type: 'download-failed'; plugin: string; url: string; reason: string }
  | { type: 'extract-failed'; plugin: string; archive: string; reason: string }
  | { type: 'path-not-found'; plugin?: string; path: string }
  | { type: 'path-traversal-detected'; plugin: string; path: string; resolvedPath: string };

export type PluginManifestError =
  | { type: 'manifest-parse-error'; plugin: string; path: string; raw: string; zodError?: string }
  | { type: 'manifest-validation-error'; plugin: string; path: string; errors: string[] }
  | { type: 'manifest-not-found'; plugin?: string; searchedPaths: string[] }
  | { type: 'invalid-manifest-format'; plugin: string; path: string; expectedFormat: string };

export type PluginRuntimeError =
  | { type: 'hook-load-failed'; plugin: string; path: string; reason: string }
  | { type: 'command-load-failed'; plugin: string; command: string; reason: string }
  | { type: 'skill-load-failed'; plugin: string; skill: string; reason: string }
  | { type: 'agent-load-failed'; plugin: string; agent: string; reason: string }
  | { type: 'capability-registration-failed'; plugin: string; capability: string; reason: string };

export type PluginMarketplaceError =
  | { type: 'marketplace-not-found'; marketplace: string; searchedPaths?: string[] }
  | { type: 'marketplace-load-failed'; marketplace: string; url: string; reason: string }
  | { type: 'marketplace-blocked-by-policy'; marketplace: string; policy: string }
  | { type: 'marketplace-impersonation-detected'; marketplace: string; reason: string }
  | { type: 'plugin-not-found'; plugin: string; marketplace: string }
  | { type: 'plugin-catalog-fetch-failed'; marketplace: string; url: string; reason: string };

export type PluginCompatError =
  | { type: 'dependency-unsatisfied'; plugin: string; missing: Array<{ id: string; version: string }> }
  | { type: 'version-constraint-failed'; plugin: string; current: string; required: string }
  | { type: 'duya-version-incompatible'; plugin: string; required: string; current: string }
  | { type: 'engine-not-supported'; plugin: string; engine: string; required: string; current: string };

export type PluginError =
  | PluginInstallError
  | PluginManifestError
  | PluginRuntimeError
  | PluginMarketplaceError
  | PluginCompatError
  | { type: 'generic-error'; plugin?: string; message: string; stack?: string };

export function isPluginError(err: unknown): err is PluginError {
  if (typeof err !== 'object' || err === null) return false;
  if (!('type' in err)) return false;
  const type = (err as Record<string, unknown>).type;
  return typeof type === 'string';
}

export function toPluginError(err: unknown, plugin?: string): PluginError {
  if (isPluginError(err)) return err;
  if (err instanceof Error) {
    return {
      type: 'generic-error',
      plugin,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    type: 'generic-error',
    plugin,
    message: typeof err === 'string' ? err : String(err),
  };
}