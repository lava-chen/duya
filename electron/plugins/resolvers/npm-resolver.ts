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

function parseNpmIdentifier(identifier: string): {
  packageName: string;
  version?: string;
} {
  let working = identifier;

  if (working.includes('@npm')) {
    const atNpmIndex = working.lastIndexOf('@npm');
    working = working.substring(0, atNpmIndex);
  }

  if (working.includes('npmjs.com/package/')) {
    working = working.split('npmjs.com/package/')[1] ?? working;
  }

  const versionMatch = working.match(/#(.+)$/);
  const version = versionMatch ? versionMatch[1] : undefined;
  if (version) {
    working = working.replace(/#.+$/, '');
  }

  if (working.startsWith('@')) {
    const atIndex = working.indexOf('@', 1);
    if (atIndex > 0) {
      return {
        packageName: working.substring(0, atIndex),
        version: version ?? working.substring(atIndex + 1) || undefined,
      };
    }
  }

  return { packageName: working, version };
}

async function npmPack(
  packageName: string,
  version: string | undefined,
  targetDir: string,
): Promise<string> {
  ensureDir(targetDir);

  const pkgSpec = version ? `${packageName}@${version}` : packageName;

  execSync(`npm pack ${pkgSpec} --pack-destination "${targetDir}"`, {
    stdio: 'pipe',
    timeout: 120_000,
    cwd: targetDir,
  });

  const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.tgz'));
  if (files.length === 0) {
    throw new Error(`npm pack produced no .tgz file for ${pkgSpec}`);
  }

  const tgzPath = path.join(targetDir, files[0]);
  execSync(`tar -xzf "${tgzPath}" -C "${targetDir}"`, {
    stdio: 'pipe',
    timeout: 30_000,
  });

  fs.unlinkSync(tgzPath);
  return path.join(targetDir, 'package');
}

export class NpmResolver implements SourceResolver {
  readonly type: PluginSourceType = 'npm';

  canHandle(identifier: string): boolean {
    if (identifier.includes('@npm')) return true;
    if (identifier.includes('npmjs.com/package/')) return true;
    return false;
  }

  async resolve(
    source: PluginSource,
    options: SourceResolveOptions,
  ): Promise<SourceResolveResult> {
    const { packageName, version } = parseNpmIdentifier(source.identifier);
    const sanitizedName = packageName.replace(/[^a-zA-Z0-9._-]/g, '_');

    const pluginDir = path.join(options.cacheDir, 'npm', sanitizedName);
    const extractDir = path.join(pluginDir, `${version || 'latest'}`);

    if (!options.cacheOnly) {
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
      ensureDir(pluginDir);

      const pkgDir = await npmPack(packageName, version, extractDir);

      const manifest = readPluginManifest(pkgDir);

      return {
        source: { ...source, resolvedPath: pkgDir },
        pluginDir: pkgDir,
        manifest,
      };
    }

    if (!fs.existsSync(extractDir)) {
      throw new Error(`NPM package not cached: ${packageName}`);
    }

    const pkgDir = path.join(extractDir, 'package');
    const manifest = readPluginManifest(pkgDir);

    return {
      source: { ...source, resolvedPath: pkgDir },
      pluginDir: pkgDir,
      manifest,
    };
  }
}