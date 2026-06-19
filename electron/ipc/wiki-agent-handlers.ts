import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import type { WikiNode, WikiIndexEntry, WikiLogEntry } from '../../packages/agent/src/wiki-agent/types.js';
import * as path from 'path';
import * as fs from 'fs';
import { getMainWikiNodeStore } from '../wiki-agent/node-store.js';
import { getWikiAgentRuntime } from '../wiki-agent/WikiAgentRuntime.js';

const logger = getLogger();

/**
 * Sanitize a user-supplied filename so it cannot escape the inbox directory
 * via path traversal (e.g. `../../../etc/passwd` or `..\..\..\windows\system32`).
 * Returns the bare filename (no directory components) or null if the input
 * is empty, contains traversal sequences, or resolves outside the inbox.
 */
function sanitizeInboxFilename(filename: string): string | null {
  if (typeof filename !== 'string' || filename.length === 0) return null;
  // Strip any directory components — only the basename is safe.
  const base = path.basename(filename);
  if (base.length === 0 || base === '.' || base === '..') return null;
  // Reject NUL bytes and control characters.
  if (/[\x00-\x1f]/.test(base)) return null;
  return base;
}

/**
 * Resolve a sanitized filename under the inbox directory and verify the
 * resolved path stays inside inbox (defense-in-depth against symlink escapes).
 */
function resolveInboxPath(filename: string): { filePath: string } | null {
  const safe = sanitizeInboxFilename(filename);
  if (!safe) return null;
  const inboxDir = path.resolve(getMainWikiNodeStore().getRootPath(), 'inbox');
  const filePath = path.resolve(inboxDir, safe);
  // Verify the resolved path is still under the inbox directory.
  if (!filePath.startsWith(inboxDir + path.sep) && filePath !== inboxDir) {
    return null;
  }
  return { filePath };
}

export function registerWikiAgentHandlers(): void {
  ipcMain.handle('wiki:listAllNodes', (): WikiIndexEntry[] => {
    try {
      return getMainWikiNodeStore().listAllNodes();
    } catch (error) {
      logger.warn('Failed to list wiki nodes', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:getNode', (_event, nodePath: string): WikiNode | null => {
    try {
      return getMainWikiNodeStore().readNode(nodePath);
    } catch (error) {
      logger.warn('Failed to read wiki node', { path: nodePath, error: String(error) }, LogComponent.Main);
      return null;
    }
  });

  ipcMain.handle('wiki:updateNode', (_event, node: WikiNode): boolean => {
    try {
      getMainWikiNodeStore().writeNode({ ...node, updatedAt: Date.now() });
      return true;
    } catch (error) {
      logger.warn('Failed to update wiki node', { nodeId: node.id, error: String(error) }, LogComponent.Main);
      return false;
    }
  });

  ipcMain.handle('wiki:deleteNode', (_event, nodePath: string): boolean => {
    try {
      getMainWikiNodeStore().deleteNode(nodePath);
      return true;
    } catch (error) {
      logger.warn('Failed to delete wiki node', { path: nodePath, error: String(error) }, LogComponent.Main);
      return false;
    }
  });

  ipcMain.handle('wiki:searchNodes', (_event, query: string): WikiIndexEntry[] => {
    try {
      return getMainWikiNodeStore().searchNodes(query);
    } catch (error) {
      logger.warn('Failed to search wiki nodes', { query, error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readIndex', (): WikiIndexEntry[] => {
    try {
      return getMainWikiNodeStore().readIndex();
    } catch (error) {
      logger.warn('Failed to read wiki index', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readLog', (): WikiLogEntry[] => {
    try {
      return getMainWikiNodeStore().readLog();
    } catch (error) {
      logger.warn('Failed to read wiki log', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:listInboxFiles', (): string[] => {
    try {
      const inboxPath = path.join(getMainWikiNodeStore().getRootPath(), 'inbox');
      if (!fs.existsSync(inboxPath)) return [];
      return fs.readdirSync(inboxPath).filter(f => f.endsWith('.md'));
    } catch (error) {
      logger.warn('Failed to list inbox files', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readInboxFile', (_event, filename: string): string | null => {
    try {
      const resolved = resolveInboxPath(filename);
      if (!resolved) {
        logger.warn('Rejected inbox file read: invalid filename', { filename }, LogComponent.Main);
        return null;
      }
      if (!fs.existsSync(resolved.filePath)) return null;
      return fs.readFileSync(resolved.filePath, 'utf-8');
    } catch (error) {
      logger.warn('Failed to read inbox file', { filename, error: String(error) }, LogComponent.Main);
      return null;
    }
  });

  ipcMain.handle('wiki:deleteInboxFile', (_event, filename: string): boolean => {
    try {
      const resolved = resolveInboxPath(filename);
      if (!resolved) {
        logger.warn('Rejected inbox file delete: invalid filename', { filename }, LogComponent.Main);
        return false;
      }
      if (fs.existsSync(resolved.filePath)) {
        fs.unlinkSync(resolved.filePath);
      }
      return true;
    } catch (error) {
      logger.warn('Failed to delete inbox file', { filename, error: String(error) }, LogComponent.Main);
      return false;
    }
  });

  ipcMain.handle('wiki:getRootPath', (): string => {
    return getMainWikiNodeStore().getRootPath();
  });

  ipcMain.handle('wiki:getRuntimeStatus', () => {
    return getWikiAgentRuntime()?.getStatus() ?? {
      observerActive: false,
      queueLength: 0,
      processing: false,
      processedCount: 0,
      phase: 'idle',
    };
  });

  logger.info('Wiki Agent IPC handlers registered', undefined, LogComponent.Main);
}
