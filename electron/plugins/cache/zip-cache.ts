import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getLogger, LogComponent } from '../../logging/logger';
import {
  getPluginVersionCacheDir,
  getPluginCacheRoot,
} from './layout';

const COMPONENT = 'ZipCache' as LogComponent;

const DEFAULT_UNUSED_DAYS_THRESHOLD = 30;

interface ArchiveManifest {
  version: 1;
  compressedAt: number;
  files: Record<string, string>;
}

export function compressPluginCache(
  marketplace: string,
  pluginId: string,
  version: string
): { archivePath: string; originalSize: number; compressedSize: number } {
  const logger = getLogger();
  const cacheDir = getPluginVersionCacheDir(marketplace, pluginId, version);

  if (!fs.existsSync(cacheDir)) {
    throw new Error(`Cache directory not found: ${cacheDir}`);
  }

  const archivePath = `${cacheDir}.tar.gz`;
  const manifest: ArchiveManifest = {
    version: 1,
    compressedAt: Date.now(),
    files: {},
  };

  const chunks: Buffer[] = [];
  let originalSize = 0;

  function collectFiles(dir: string, basePath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        originalSize += content.length;
        const compressed = zlib.gzipSync(content);
        manifest.files[relativePath] = compressed.toString('base64');
      } else if (entry.isDirectory()) {
        collectFiles(fullPath, basePath);
      }
    }
  }

  collectFiles(cacheDir, cacheDir);

  const manifestJson = JSON.stringify(manifest, null, 2);
  chunks.push(Buffer.from(manifestJson, 'utf8'));

  const archive = Buffer.concat(chunks);
  fs.writeFileSync(archivePath, archive);

  const compressedSize = archive.length;

  fs.rmSync(cacheDir, { recursive: true, force: true });

  logger.info(
    'Plugin cache compressed',
    { pluginId, version, originalSize, compressedSize, ratio: (compressedSize / originalSize).toFixed(2) },
    COMPONENT
  );

  return { archivePath, originalSize, compressedSize };
}

export function decompressPluginCache(
  marketplace: string,
  pluginId: string,
  version: string
): string {
  const logger = getLogger();
  const cacheDir = getPluginVersionCacheDir(marketplace, pluginId, version);
  const archivePath = `${cacheDir}.tar.gz`;

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }

  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  const archive = fs.readFileSync(archivePath);
  const manifestEnd = archive.indexOf(Buffer.from('\n'));
  const manifestJson = manifestEnd > 0
    ? archive.slice(0, manifestEnd).toString('utf8')
    : archive.toString('utf8');

  const manifest: ArchiveManifest = JSON.parse(manifestJson);

  for (const [relativePath, base64Content] of Object.entries(manifest.files)) {
    const targetPath = path.join(cacheDir, relativePath);
    const targetDir = path.dirname(targetPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const compressed = Buffer.from(base64Content, 'base64');
    const decompressed = zlib.gunzipSync(compressed);
    fs.writeFileSync(targetPath, decompressed);
  }

  fs.unlinkSync(archivePath);

  logger.info('Plugin cache decompressed', { pluginId, version }, COMPONENT);
  return cacheDir;
}

export function isPluginCacheCompressed(
  marketplace: string,
  pluginId: string,
  version: string
): boolean {
  const archivePath = `${getPluginVersionCacheDir(marketplace, pluginId, version)}.tar.gz`;
  return fs.existsSync(archivePath);
}

export function compressUnusedPlugins(
  thresholdDays: number = DEFAULT_UNUSED_DAYS_THRESHOLD
): string[] {
  const logger = getLogger();
  const cacheRoot = getPluginCacheRoot();
  const compressed: string[] = [];

  if (!fs.existsSync(cacheRoot)) return compressed;

  const now = Date.now();
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

  function walk(dir: string, depth: number): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth === 2) {
          try {
            const stat = fs.statSync(fullPath);
            const age = now - stat.atimeMs;

            if (age > thresholdMs) {
              const parts = fullPath.split(path.sep);
              const version = parts[parts.length - 1];
              const pluginId = parts[parts.length - 2];
              const marketplace = parts[parts.length - 3];

              try {
                compressPluginCache(marketplace, pluginId, version);
                compressed.push(`${marketplace}/${pluginId}/${version}`);
              } catch {
                logger.warn(`Failed to compress plugin cache: ${fullPath}`, {}, COMPONENT);
              }
            }
          } catch {
            // skip
          }
        } else {
          walk(fullPath, depth + 1);
        }
      }
    }
  }

  walk(cacheRoot, 0);
  return compressed;
}

export function decompressOnAccess(
  marketplace: string,
  pluginId: string,
  version: string
): void {
  if (isPluginCacheCompressed(marketplace, pluginId, version)) {
    decompressPluginCache(marketplace, pluginId, version);
  }
}