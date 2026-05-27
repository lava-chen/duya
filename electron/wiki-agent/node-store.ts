import { app } from 'electron';
import * as path from 'path';
import {
  WikiNodeStore,
  createWikiNodeStore,
} from '../../packages/agent/src/wiki-agent/WikiNodeStore.js';

let nodeStore: WikiNodeStore | null = null;

export function getWikiStoreBasePath(): string {
  return path.join(app.getPath('userData'), 'wiki');
}

export function getMainWikiNodeStore(): WikiNodeStore {
  if (!nodeStore) {
    nodeStore = createWikiNodeStore(getWikiStoreBasePath());
    nodeStore.initialize();
  }

  return nodeStore;
}
