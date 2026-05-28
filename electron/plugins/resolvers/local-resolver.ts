import fs from 'fs';
import path from 'path';
import { readPluginManifest } from '../manifest';
import type {
  PluginSource,
  PluginSourceType,
  SourceResolveOptions,
  SourceResolveResult,
  SourceResolver,
} from './types';

function resolveFilePath(basePath: string): string {
  if (path.isAbsolute(basePath)) return basePath;
  return path.resolve(process.cwd(), basePath);
}

export class LocalPathResolver implements SourceResolver {
  readonly type: PluginSourceType = 'local-path';

  canHandle(identifier: string): boolean {
    if (identifier.includes('@local')) return true;
    if (path.isAbsolute(identifier)) return true;
    if (identifier.startsWith('./') || identifier.startsWith('../')) return true;
    if (identifier.startsWith('.\\') || identifier.startsWith('..\\')) return true;
    return false;
  }

  async resolve(
    source: PluginSource,
    _options: SourceResolveOptions,
  ): Promise<SourceResolveResult> {
    let dirPath = source.identifier;

    if (dirPath.includes('@local')) {
      dirPath = dirPath.replace('@local', '');
    }

    const resolved = resolveFilePath(dirPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Local plugin path not found: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Local plugin path is not a directory: ${resolved}`);
    }

    const manifest = readPluginManifest(resolved);

    return {
      source: { ...source, resolvedPath: resolved },
      pluginDir: resolved,
      manifest,
    };
  }
}