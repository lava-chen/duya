export type WikiNodeType =
  | 'concept'
  | 'module'
  | 'class'
  | 'function'
  | 'workflow'
  | 'devops'
  | 'inbox';

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

export interface WikiIndexEntry {
  id: string;
  title: string;
  path: string;
  type: WikiNodeType;
  aliases: string[];
  summary?: string;
  tags?: string[];
}

export interface WikiLogEntry {
  timestamp: number;
  operation: string;
  details?: Record<string, unknown>;
}

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

export interface MergeDecision {
  action: 'merge' | 'skip' | 'uncertain';
  targetNodeId?: string;
  targetNodeTitle?: string;
  confidence: number;
  reason: string;
}

export interface ChangeLogEntry {
  timestamp: number;
  sessionId: string;
  operation: 'create' | 'merge' | 'update' | 'inbox';
  nodeId: string;
  nodeTitle: string;
  details: string;
}

export type MemoryViewTab = 'graph' | 'tree' | 'inbox' | 'activity';

export type NodeStatus = 'active' | 'merged' | 'archived';

export interface WikiFileTreeItem {
  name: string;
  path: string;
  type: 'directory' | 'file';
  nodeType?: WikiNodeType;
  children?: WikiFileTreeItem[];
}