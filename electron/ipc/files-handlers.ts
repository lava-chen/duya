/**
 * ipc/files-handlers.ts - File operations IPC handlers
 *
 * Handlers for:
 * - File tree browsing
 * - File/folder deletion
 * - File/folder renaming
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getLogger, LogComponent } from '../logging/logger';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  extension?: string;
  children?: FileTreeNode[];
}

const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.DS_Store',
  'Thumbs.db',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '*.log',
]);

function shouldIgnore(name: string): boolean {
  if (IGNORED_ENTRIES.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (name.endsWith('.log')) return true;
  return false;
}

function getExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

function buildFileTree(dirPath: string, baseDir: string, depth: number, maxDepth: number): FileTreeNode[] {
  if (depth > maxDepth) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      if (shouldIgnore(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        const children = buildFileTree(fullPath, baseDir, depth + 1, maxDepth);
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'directory',
          children,
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          extension: getExtension(entry.name),
        });
      }
    }

    nodes.sort((a, b) => {
      if (a.type === b.type) {
        return a.name.localeCompare(b.name);
      }
      return a.type === 'directory' ? -1 : 1;
    });

    return nodes;
  } catch (error) {
    const logger = getLogger();
    logger.error('Failed to read directory', error instanceof Error ? error : new Error(String(error)), { dirPath }, LogComponent.Files);
    return [];
  }
}

export function registerFilesHandlers(): void {
  ipcMain.handle('files:browse', async (_event, dirPath: string, maxDepth = 4) => {
    try {
      if (!dirPath || typeof dirPath !== 'string') {
        return { success: false, error: 'Invalid directory path', tree: [] };
      }

      const resolvedPath = path.resolve(dirPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Directory does not exist', tree: [] };
      }

      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return { success: false, error: 'Path is not a directory', tree: [] };
      }

      const tree = buildFileTree(resolvedPath, resolvedPath, 0, maxDepth);
      return { success: true, tree };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:browse error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error), tree: [] };
    }
  });

  ipcMain.handle('files:delete', async (_event, targetPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string') {
        return { success: false, error: 'Invalid path' };
      }

      const resolvedPath = path.resolve(targetPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Path does not exist' };
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        fs.rmdirSync(resolvedPath, { recursive: true });
      } else {
        fs.unlinkSync(resolvedPath);
      }

      return { success: true };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:delete error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('files:rename', async (_event, targetPath: string, newName: string) => {
    try {
      if (!targetPath || typeof targetPath !== 'string' || !newName || typeof newName !== 'string') {
        return { success: false, error: 'Invalid path or name' };
      }

      const resolvedPath = path.resolve(targetPath);
      if (!fs.existsSync(resolvedPath)) {
        return { success: false, error: 'Path does not exist' };
      }

      const parentDir = path.dirname(resolvedPath);
      const newPath = path.join(parentDir, newName);

      if (fs.existsSync(newPath)) {
        return { success: false, error: 'A file or folder with that name already exists' };
      }

      fs.renameSync(resolvedPath, newPath);
      return { success: true, newPath };
    } catch (error) {
      const logger = getLogger();
      logger.error('files:rename error', error instanceof Error ? error : new Error(String(error)), undefined, 'Main');
      return { success: false, error: String(error) };
    }
  });
}