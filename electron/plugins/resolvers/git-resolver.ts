import { execSync } from 'child_process';
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

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseGitUrl(identifier: string): {
  url: string;
  subdir?: string;
  ref?: string;
} {
  let working = identifier;

  if (working.startsWith('git+')) {
    working = working.substring(4);
  }

  const hashIndex = working.indexOf('#');
  if (hashIndex > 0) {
    const fragment = working.substring(hashIndex + 1);
    working = working.substring(0, hashIndex);
    return { url: working, subdir: fragment, ref: undefined };
  }

  return { url: working };
}

export class GitResolver implements SourceResolver {
  readonly type: PluginSourceType = 'https-git';

  canHandle(identifier: string): boolean {
    if (identifier.startsWith('git+')) return true;
    if (/^https?:\/\/.+\.git$/.test(identifier)) return true;
    if (identifier.includes('@') && identifier.includes('.git')) return true;
    if (identifier.includes('#') && !identifier.startsWith('http')) return true;
    return false;
  }

  async resolve(
    source: PluginSource,
    options: SourceResolveOptions,
  ): Promise<SourceResolveResult> {
    const { url, subdir, ref } = parseGitUrl(source.identifier);

    const sanitized = url
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 64);

    const targetDir = path.join(options.cacheDir, 'git', sanitized);

    let result: SourceResolveResult;

    if (!options.cacheOnly) {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      ensureDir(path.dirname(targetDir));

      const args = ['clone', '--depth', '1'];
      if (ref) {
        args.push('--branch', ref);
      }
      args.push('--single-branch');
      args.push(url, targetDir);

      execSync(`git ${args.join(' ')}`, {
        stdio: 'pipe',
        timeout: 120_000,
      });

      const manifestDir = subdir ? path.join(targetDir, subdir) : targetDir;
      const manifest = readPluginManifest(manifestDir);

      result = {
        source: { ...source, resolvedPath: targetDir },
        pluginDir: manifestDir,
        manifest,
      };
    } else {
      if (!fs.existsSync(targetDir)) {
        throw new Error(`Git repo not cached: ${url}`);
      }

      const manifestDir = subdir ? path.join(targetDir, subdir) : targetDir;
      const manifest = readPluginManifest(manifestDir);

      result = {
        source: { ...source, resolvedPath: targetDir },
        pluginDir: manifestDir,
        manifest,
      };
    }

    return result;
  }
}

export class GitSubdirResolver extends GitResolver {
  readonly type: PluginSourceType = 'git-subdir';

  canHandle(identifier: string): boolean {
    return (
      super.canHandle(identifier) &&
      (identifier.includes('#') || identifier.includes(':subdir:'))
    );
  }
}