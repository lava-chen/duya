import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import type { WikiNode, WikiIndexEntry, WikiLogEntry } from '../../packages/agent/src/wiki-agent/types.js';
import * as path from 'path';
import * as fs from 'fs';
import { getMainWikiNodeStore } from '../wiki-agent/node-store.js';
import { getWikiAgentRuntime } from '../wiki-agent/WikiAgentRuntime.js';

const logger = getLogger();

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
      const filePath = path.join(getMainWikiNodeStore().getRootPath(), 'inbox', filename);
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      logger.warn('Failed to read inbox file', { filename, error: String(error) }, LogComponent.Main);
      return null;
    }
  });

  ipcMain.handle('wiki:deleteInboxFile', (_event, filename: string): boolean => {
    try {
      const filePath = path.join(getMainWikiNodeStore().getRootPath(), 'inbox', filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
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
