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

async function downloadZip(url: string, destPath: string): Promise<void> {
  execSync(
    `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${destPath}' -UseBasicParsing"`,
    {
      stdio: 'pipe',
      timeout: 300_000,
    },
  );
}

async function extractZip(zipPath: string, extractDir: string): Promise<void> {
  ensureDir(extractDir);
  execSync(
    `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
    {
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
}

function findManifestDir(rootDir: string): string {
  const pluginJsonPath = path.join(rootDir, 'plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    return rootDir;
  }

  if (fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory()) {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subPath = path.join(rootDir, entry.name);
      const nestedManifest = path.join(subPath, 'plugin.json');
      if (fs.existsSync(nestedManifest)) {
        return subPath;
      }
    }
  }

  throw new Error(`No plugin.json found in extracted archive: ${rootDir}`);
}

export class UrlZipResolver implements SourceResolver {
  readonly type: PluginSourceType = 'url-zip';

  canHandle(identifier: string): boolean {
    return (
      /^https?:\/\//.test(identifier) &&
      !identifier.includes('github.com') &&
      !identifier.endsWith('.git')
    );
  }

  async resolve(
    source: PluginSource,
    options: SourceResolveOptions,
  ): Promise<SourceResolveResult> {
    const sanitized = source.identifier
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .substring(0, 64);

    const cacheDir = path.join(options.cacheDir, 'url-zip', sanitized);

    if (!options.cacheOnly) {
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
      ensureDir(cacheDir);

      const zipPath = path.join(cacheDir, 'plugin.zip');
      await downloadZip(source.identifier, zipPath);

      if (!fs.existsSync(zipPath)) {
        throw new Error(`Download failed: ${source.identifier}`);
      }

      const extractDir = path.join(cacheDir, 'extracted');
      await extractZip(zipPath, extractDir);

      const manifestDir = findManifestDir(extractDir);
      const manifest = readPluginManifest(manifestDir);

      return {
        source: { ...source, resolvedPath: cacheDir },
        pluginDir: manifestDir,
        manifest,
      };
    }

    if (!fs.existsSync(cacheDir)) {
      throw new Error(`URL ZIP not cached: ${source.identifier}`);
    }

    const extractDir = path.join(cacheDir, 'extracted');
    const manifestDir = findManifestDir(extractDir);
    const manifest = readPluginManifest(manifestDir);

    return {
      source: { ...source, resolvedPath: cacheDir },
      pluginDir: manifestDir,
      manifest,
    };
  }
}