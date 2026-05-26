/**
 * Wiki Agent Types
 * Type definitions for WikiAgent and related components
 */

/**
 * Wiki node types
 */
export type WikiNodeType =
  | 'concept'
  | 'module'
  | 'class'
  | 'function'
  | 'workflow'
  | 'devops'
  | 'inbox';

/**
 * Wiki node structure
 */
export interface WikiNode {
  id: string;
  type: WikiNodeType;
  title: string;
  path: string;
  content: string;
  aliases: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  backlinks: string[];
  sourceSessions?: string[];
  lastObservedAt?: number;
}

/**
 * Wiki index entry
 */
export interface WikiIndexEntry {
  id: string;
  title: string;
  path: string;
  type: WikiNodeType;
  aliases: string[];
  summary?: string;
  tags?: string[];
}

/**
 * Wiki log entry
 */
export interface WikiLogEntry {
  timestamp: number;
  operation: string;
  details?: Record<string, unknown>;
}

/**
 * Memory candidate extracted from conversation
 */
export interface MemoryCandidate {
  id: string;
  title: string;
  type: WikiNodeType;
  content: string;
  aliases: string[];
  tags: string[];
  originalContext: string;
  confidence: number;
  suggestedAction: 'create' | 'merge' | 'inbox';
  mergeTargetId?: string;
}

/**
 * Merge decision result
 */
export interface MergeDecision {
  action: 'merge' | 'skip' | 'uncertain';
  targetNodeId?: string;
  targetNodeTitle?: string;
  confidence: number;
  reason: string;
}

/**
 * Change log entry for wiki modifications
 */
export interface ChangeLogEntry {
  timestamp: number;
  sessionId: string;
  operation: 'create' | 'merge' | 'update' | 'inbox';
  nodeId: string;
  nodeTitle: string;
  details: string;
}

/**
 * Wiki search result
 */
export interface WikiSearchResult {
  node: WikiIndexEntry;
  score: number;
  matchType: 'title' | 'alias' | 'content' | 'tag';
}

/**
 * Wiki read result
 */
export interface WikiReadResult {
  node: WikiNode;
  content: string;
}

/**
 * Wiki search options
 */
export interface WikiSearchOptions {
  query: string;
  limit?: number;
  types?: WikiNodeType[];
}

/**
 * Wiki read options
 */
export interface WikiReadOptions {
  path: string;
}
