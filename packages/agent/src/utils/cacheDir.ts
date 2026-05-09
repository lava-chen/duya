import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

let cachedCacheDir: string | undefined;

export function getCacheDir(subdir?: string): string {
  if (cachedCacheDir && !subdir) {
    return cachedCacheDir;
  }

  let cacheRoot: string;

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
    if (appData) {
      cacheRoot = path.join(appData, 'DUYA', 'cache');
    } else {
      cacheRoot = path.join(os.homedir(), '.duya', 'cache');
    }
  } else if (process.platform === 'darwin') {
    cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'DUYA');
  } else {
    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) {
      cacheRoot = path.join(xdgCache, 'duya');
    } else {
      cacheRoot = path.join(os.homedir(), '.cache', 'duya');
    }
  }

  const cacheDir = subdir ? path.join(cacheRoot, subdir) : cacheRoot;

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  if (!subdir) {
    cachedCacheDir = cacheDir;
  }

  return cacheDir;
}

export function getWebArticlesCacheDir(): string {
  return getCacheDir('web-articles');
}

export function clearCacheDir(subdir?: string): void {
  const cacheDir = subdir ? getCacheDir(subdir) : getCacheDir();
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  if (!subdir) {
    cachedCacheDir = undefined;
  }
}
