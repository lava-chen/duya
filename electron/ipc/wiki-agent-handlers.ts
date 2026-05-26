import { ipcMain, app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import { WikiNodeStore, createWikiNodeStore } from '../../packages/agent/src/wiki-agent/WikiNodeStore.js';
import type { WikiNode, WikiIndexEntry, WikiLogEntry } from '../../packages/agent/src/wiki-agent/types.js';
import * as path from 'path';
import * as fs from 'fs';

const logger = getLogger();

let nodeStore: WikiNodeStore | null = null;

function getNodeStore(): WikiNodeStore {
  if (!nodeStore) {
    const basePath = path.join(app.getPath('userData'), 'wiki');
    nodeStore = createWikiNodeStore(basePath);
    nodeStore.initialize();
  }
  return nodeStore;
}

export function registerWikiAgentHandlers(): void {
  ipcMain.handle('wiki:listAllNodes', (): WikiIndexEntry[] => {
    try {
      return getNodeStore().listAllNodes();
    } catch (error) {
      logger.warn('Failed to list wiki nodes', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:getNode', (_event, nodePath: string): WikiNode | null => {
    try {
      return getNodeStore().readNode(nodePath);
    } catch (error) {
      logger.warn('Failed to read wiki node', { path: nodePath, error: String(error) }, LogComponent.Main);
      return null;
    }
  });

  ipcMain.handle('wiki:updateNode', (_event, node: WikiNode): boolean => {
    try {
      getNodeStore().writeNode({ ...node, updatedAt: Date.now() });
      return true;
    } catch (error) {
      logger.warn('Failed to update wiki node', { nodeId: node.id, error: String(error) }, LogComponent.Main);
      return false;
    }
  });

  ipcMain.handle('wiki:deleteNode', (_event, nodePath: string): boolean => {
    try {
      getNodeStore().deleteNode(nodePath);
      return true;
    } catch (error) {
      logger.warn('Failed to delete wiki node', { path: nodePath, error: String(error) }, LogComponent.Main);
      return false;
    }
  });

  ipcMain.handle('wiki:searchNodes', (_event, query: string): WikiIndexEntry[] => {
    try {
      return getNodeStore().searchNodes(query);
    } catch (error) {
      logger.warn('Failed to search wiki nodes', { query, error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readIndex', (): WikiIndexEntry[] => {
    try {
      return getNodeStore().readIndex();
    } catch (error) {
      logger.warn('Failed to read wiki index', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readLog', (): WikiLogEntry[] => {
    try {
      return getNodeStore().readLog();
    } catch (error) {
      logger.warn('Failed to read wiki log', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:listInboxFiles', (): string[] => {
    try {
      const inboxPath = path.join(getNodeStore().getRootPath(), 'inbox');
      if (!fs.existsSync(inboxPath)) return [];
      return fs.readdirSync(inboxPath).filter(f => f.endsWith('.md'));
    } catch (error) {
      logger.warn('Failed to list inbox files', { error: String(error) }, LogComponent.Main);
      return [];
    }
  });

  ipcMain.handle('wiki:readInboxFile', (_event, filename: string): string | null => {
    try {
      const filePath = path.join(getNodeStore().getRootPath(), 'inbox', filename);
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      logger.warn('Failed to read inbox file', { filename, error: String(error) }, LogComponent.Main);
      return null;
    }
  });

  ipcMain.handle('wiki:deleteInboxFile', (_event, filename: string): boolean => {
    try {
      const filePath = path.join(getNodeStore().getRootPath(), 'inbox', filename);
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
    return getNodeStore().getRootPath();
  });

  logger.info('Wiki Agent IPC handlers registered', undefined, LogComponent.Main);
}