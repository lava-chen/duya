/**
 * Wiki Agent types and interfaces
 */

/**
 * Job status in the queue
 */
export type WikiAgentJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * A job in the Wiki Agent queue
 * Uses sessionId + turnId for idempotency
 */
export interface WikiAgentJob {
  id: string;
  sessionId: string;
  turnId: string;
  status: WikiAgentJobStatus;
  payload: ChatDonePayload;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  processedAt?: number;
  error?: string;
}

/**
 * Payload from chat:done event
 */
export interface ChatDonePayload {
  sessionId: string;
  turnId: string;
  finalContent: string;
  timestamp: number;
  metadata?: {
    model?: string;
    tokenUsage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

/**
 * Wiki node types
 */
export type WikiNodeType = 'concept' | 'module' | 'class' | 'function' | 'workflow' | 'devops' | 'inbox';

/**
 * A wiki node (markdown file)
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
}

/**
 * Index entry for search
 */
export interface WikiIndexEntry {
  id: string;
  title: string;
  path: string;
  type: WikiNodeType;
  aliases: string[];
  summary?: string;
}

/**
 * Log entry for tracking operations
 */
export interface WikiLogEntry {
  timestamp: number;
  operation: 'create' | 'update' | 'delete' | 'search' | 'read';
  nodeId?: string;
  sessionId?: string;
  turnId?: string;
  details?: Record<string, unknown>;
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
 * Wiki directory structure
 */
export interface WikiDirectoryStructure {
  root: string;
  concepts: string;
  modules: string;
  classes: string;
  workflows: string;
  devops: string;
  inbox: string;
}
