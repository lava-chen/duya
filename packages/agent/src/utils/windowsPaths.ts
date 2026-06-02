/**
 * Windows path conversion utilities.
 *
 * On Windows, Git Bash uses POSIX-style paths (/c/Users/...) while
 * Node.js uses native Windows paths (C:\Users\...). These utilities
 * bridge the two so shell commands and file operations can coexist.
 *
 * Adapted from claude-code-haha's windowsPaths.ts.
 */

const posixToWindowsCache = new Map<string, string>();
const windowsToPosixCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

function memoize<K, V>(cache: Map<K, V>, key: K, factory: (k: K) => V, maxSize: number): V {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cache.size >= maxSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  const value = factory(key);
  cache.set(key, value);
  return value;
}

/** Convert a Windows path to a POSIX path using pure JS. */
export function windowsPathToPosixPath(windowsPath: string): string {
  return memoize(windowsToPosixCache, windowsPath, (p: string) => {
    if (p.startsWith('\\\\')) {
      return p.replace(/\\/g, '/');
    }
    const match = p.match(/^([A-Za-z]):[/\\]/);
    if (match) {
      const driveLetter = match[1]!.toLowerCase();
      return '/' + driveLetter + p.slice(2).replace(/\\/g, '/');
    }
    return p.replace(/\\/g, '/');
  }, MAX_CACHE_SIZE);
}

/** Convert a POSIX path to a Windows path using pure JS. */
export function posixPathToWindowsPath(posixPath: string): string {
  return memoize(posixToWindowsCache, posixPath, (p: string) => {
    if (p.startsWith('//')) {
      return p.replace(/\//g, '\\');
    }
    const cygdriveMatch = p.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase();
      const rest = p.slice(('/cygdrive/' + cygdriveMatch[1]).length);
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
    }
    const driveMatch = p.match(/^\/([A-Za-z])(\/|$)/);
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase();
      const rest = p.slice(2);
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
    }
    return p.replace(/\//g, '\\');
  }, MAX_CACHE_SIZE);
}