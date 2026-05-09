/**
 * Path utilities - Unified path handling for cross-platform compatibility
 *
 * Inspired by claude-code-haha's path handling:
 * - Automatic ~ expansion to home directory
 * - POSIX to Windows path conversion on Windows
 * - Consistent path normalization
 */

import { homedir } from 'os';
import { isAbsolute, join, normalize, resolve } from 'path';

/**
 * Convert a POSIX path to Windows path.
 * Handles formats like /c/Users/... (MSYS2/Git Bash) and /cygdrive/c/...
 */
export function posixPathToWindowsPath(posixPath: string): string {
  // Handle UNC paths: //server/share -> \\server\share
  if (posixPath.startsWith('//')) {
    return posixPath.replace(/\//g, '\\');
  }

  // Handle /cygdrive/c/... format
  const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if (cygdriveMatch) {
    const driveLetter = cygdriveMatch[1]!.toUpperCase();
    const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length);
    return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
  }

  // Handle /c/... format (MSYS2/Git Bash)
  const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if (driveMatch) {
    const driveLetter = driveMatch[1]!.toUpperCase();
    const rest = posixPath.slice(2);
    return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\');
  }

  // Already Windows or relative — just flip slashes
  return posixPath.replace(/\//g, '\\');
}

/**
 * Expand a path that may contain:
 * - ~ (home directory)
 * - ~/path (path within home directory)
 * - POSIX paths on Windows (/c/Users/... → C:\Users\...)
 * - Relative paths (resolved against baseDir)
 * - Absolute paths (returned normalized)
 *
 * @param filePath - The path to expand
 * @param baseDir - Base directory for relative paths (defaults to process.cwd())
 * @returns Expanded absolute path in native format
 */
export function expandPath(filePath: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? process.cwd();

  // Security: Check for null bytes
  if (filePath.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  // Handle empty or whitespace-only paths
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return normalize(actualBaseDir);
  }

  // Handle home directory notation
  if (trimmedPath === '~') {
    return homedir();
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2));
  }

  // On Windows, convert POSIX-style paths (e.g., /c/Users/...) to Windows format
  let processedPath = trimmedPath;
  if (process.platform === 'win32' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath);
    } catch {
      // If conversion fails, use original path
      processedPath = trimmedPath;
    }
  }

  // Handle absolute paths
  if (isAbsolute(processedPath)) {
    return normalize(processedPath);
  }

  // Handle relative paths
  return resolve(actualBaseDir, processedPath);
}

/**
 * Expand tilde at the start of a path (legacy function, use expandPath instead)
 */
export function expandTilde(filePath: string): string {
  return expandPath(filePath);
}

/**
 * Get the directory containing a path
 */
export function getDirectoryForPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSep = normalized.lastIndexOf('/');
  if (lastSep === -1) {
    return '.';
  }
  return normalized.substring(0, lastSep) || '/';
}

/**
 * Check if path contains dangerous traversal patterns
 */
export function containsPathTraversal(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/../') || normalized.endsWith('/..') || normalized === '..';
}

/**
 * Check if a path is a UNC path (Windows network path)
 */
export function isUNCPath(filePath: string): boolean {
  return /^\\\\|^unc\\|^smb:/i.test(filePath);
}

/**
 * Normalize path separators for cross-platform comparison
 */
export function normalizeSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
