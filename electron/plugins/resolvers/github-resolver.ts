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

function parseGitHubIdentifier(identifier: string): {
  owner: string;
  repo: string;
  subdir?: string;
  ref?: string;
} {
  let working = identifier;

  if (working.startsWith('https://github.com/')) {
    working = working.replace('https://github.com/', '');
  }

  const refMatch = working.match(/#(.+)$/);
  const ref = refMatch ? refMatch[1] : undefined;
  if (ref) {
    working = working.replace(/#.+$/, '');
  }

  const treeMatch = working.match(/\/tree\/([^/]+)\/(.+)/);
  if (treeMatch) {
    return {
      owner: working.split('/')[0],
      repo: working.split('/')[1],
      ref: treeMatch[1],
      subdir: treeMatch[2],
    };
  }

  const parts = working.split('/');
  const owner = parts[0];
  const repo = parts[1]?.replace('.git', '') ?? '';
  const subdir = parts.length > 2 ? parts.slice(2).join('/') : undefined;

  return { owner, repo, subdir, ref };
}

async function gitClone(
  url: string,
  targetDir: string,
  ref?: string,
): Promise<void> {
  ensureDir(targetDir);

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
}

export class GitHubResolver implements SourceResolver {
  readonly type: PluginSourceType = 'github';

  canHandle(identifier: string): boolean {
    if (/^https?:\/\/github\.com\//.test(identifier)) return true;
    if (/^[a-zA-Z0-9._-]+@github/.test(identifier)) return true;
    return false;
  }

  async resolve(
    source: PluginSource,
    options: SourceResolveOptions,
  ): Promise<SourceResolveResult> {
    const { owner, repo, subdir, ref } = parseGitHubIdentifier(source.identifier);
    const sanitizedName = `${owner}-${repo}`.replace(/[^a-zA-Z0-9._-]/g, '_');

    const pluginDir = path.join(options.cacheDir, 'github', sanitizedName);
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;

    if (!options.cacheOnly) {
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      ensureDir(path.dirname(pluginDir));
      await gitClone(cloneUrl, pluginDir, ref);
    }

    if (!fs.existsSync(pluginDir)) {
      throw new Error(`GitHub clone failed: ${cloneUrl}`);
    }

    const manifestDir = subdir ? path.join(pluginDir, subdir) : pluginDir;
    const manifest = readPluginManifest(manifestDir);

    return {
      source: { ...source, resolvedPath: pluginDir },
      pluginDir: manifestDir,
      manifest,
    };
  }
}