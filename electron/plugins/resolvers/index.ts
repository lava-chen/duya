import type { PluginSource, PluginSourceType, SourceResolveOptions, SourceResolveResult, SourceResolver } from './types';
import { parsePluginIdentifier } from './identifier-parser';
import { GitHubResolver } from './github-resolver';
import { NpmResolver } from './npm-resolver';
import { LocalPathResolver } from './local-resolver';
import { GitResolver, GitSubdirResolver } from './git-resolver';
import { UrlZipResolver } from './url-resolver';

const sourceResolvers: Map<PluginSourceType, SourceResolver> = new Map();

function registerResolver(resolver: SourceResolver): void {
  sourceResolvers.set(resolver.type, resolver);
}

registerResolver(new GitHubResolver());
registerResolver(new NpmResolver());
registerResolver(new LocalPathResolver());
registerResolver(new GitResolver());
registerResolver(new GitSubdirResolver());
registerResolver(new UrlZipResolver());

export async function resolvePluginSource(
  rawIdentifier: string,
  options: SourceResolveOptions,
): Promise<SourceResolveResult> {
  const source = parsePluginIdentifier(rawIdentifier);

  const resolver = sourceResolvers.get(source.type);
  if (!resolver) {
    throw new Error(`No resolver found for source type: ${source.type}`);
  }

  return resolver.resolve(source, options);
}

export function resolveBuiltinPlugin(
  pluginDir: string,
): { pluginDir: string; source: PluginSource } {
  const source: PluginSource = {
    type: 'builtin-directory',
    identifier: pluginDir,
    resolvedPath: pluginDir,
    marketplace: 'builtin',
  };

  return { pluginDir, source };
}

export { parsePluginIdentifier } from './identifier-parser';
export { mergePluginsByPriority, buildPrioritizedList } from './multi-source-merger';
export type { PluginSource, PluginSourceType, SourceResolveOptions, SourceResolveResult, SourceResolver, PluginPriority, PrioritizedPlugin, MergeOptions } from './types';