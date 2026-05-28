import type { PluginManifest, PluginRegistryEntry } from '../types';

export type PluginSourceType =
  | 'builtin-directory'
  | 'github'
  | 'npm'
  | 'git-subdir'
  | 'https-git'
  | 'local-path'
  | 'url-zip';

export interface PluginSource {
  type: PluginSourceType;
  identifier: string;
  resolvedPath?: string;
  marketplace?: string;
}

export interface SourceResolveOptions {
  cacheDir: string;
  force?: boolean;
  cacheOnly?: boolean;
  auth?: {
    githubToken?: string;
    npmToken?: string;
  };
}

export interface SourceResolveResult {
  source: PluginSource;
  pluginDir: string;
  manifest: PluginManifest;
}

export interface SourceResolver {
  readonly type: PluginSourceType;
  resolve(
    source: PluginSource,
    options: SourceResolveOptions,
  ): Promise<SourceResolveResult>;
  canHandle(identifier: string): boolean;
}

export type PluginPriority =
  | 'session'       // --plugin-dir CLI
  | 'managed'       // enterprise managed settings lock
  | 'user'          // user-installed plugins
  | 'project'       // .duya/plugins/ directory
  | 'builtin';      // built-in plugins

export const PRIORITY_ORDER: PluginPriority[] = [
  'session',
  'managed',
  'user',
  'project',
  'builtin',
];

export interface PrioritizedPlugin {
  entry: PluginRegistryEntry;
  source: PluginSource;
  priority: PluginPriority;
}

export interface MergeOptions {
  managedLockedIds?: Set<string>;
  sessionPluginIds?: Set<string>;
}