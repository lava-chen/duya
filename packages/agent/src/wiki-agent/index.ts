/**
 * Wiki Agent module exports
 */

export type {
  WikiNode,
  WikiNodeType,
  WikiIndexEntry,
  WikiLogEntry,
  WikiSearchResult,
  WikiReadResult,
  WikiSearchOptions,
  WikiReadOptions,
} from './types.js';

export {
  WikiNodeStore,
  createWikiNodeStore,
  PathSecurityError,
} from './WikiNodeStore.js';
