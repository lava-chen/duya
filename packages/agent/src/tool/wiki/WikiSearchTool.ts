/**
 * WikiSearchTool - Search wiki nodes by query
 * Searches index.md, aliases, and supports recall hook
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { RenderedToolMessage, ToolInterruptBehavior } from '../types.js';
import { WikiNodeStore, PathSecurityError } from '../../wiki-agent/WikiNodeStore.js';
import type { WikiSearchResult } from '../../wiki-agent/types.js';

// ============================================================
// Input Types
// ============================================================

export interface WikiSearchInput {
  query: string;
  limit?: number;
  types?: string[];
}

// ============================================================
// Input Validation
// ============================================================

export function validateWikiSearchInput(input: unknown): { valid: true; data: WikiSearchInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.query || typeof obj.query !== 'string') {
    return { valid: false, error: 'query must be a non-empty string' };
  }

  if (obj.query.trim().length === 0) {
    return { valid: false, error: 'query cannot be empty' };
  }

  if (obj.limit !== undefined) {
    if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1 || obj.limit > 100) {
      return { valid: false, error: 'limit must be an integer between 1 and 100' };
    }
  }

  if (obj.types !== undefined) {
    if (!Array.isArray(obj.types)) {
      return { valid: false, error: 'types must be an array' };
    }
    const validTypes = ['concept', 'module', 'class', 'function', 'workflow', 'devops', 'inbox'];
    for (const type of obj.types) {
      if (typeof type !== 'string' || !validTypes.includes(type)) {
        return { valid: false, error: `Invalid type: ${type}. Valid types: ${validTypes.join(', ')}` };
      }
    }
  }

  return {
    valid: true,
    data: {
      query: obj.query as string,
      limit: obj.limit as number | undefined,
      types: obj.types as string[] | undefined,
    },
  };
}

// ============================================================
// Tool Implementation
// ============================================================

export class WikiSearchTool extends BaseTool {
  readonly name = 'wiki_search';
  readonly description = 'Search the wiki knowledge base for nodes matching a query. Searches through node titles, aliases, and content. Returns a list of matching wiki nodes with relevance scores.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find wiki nodes. Searches in titles, aliases, and content.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (1-100). Default: 10.',
        minimum: 1,
        maximum: 100,
      },
      types: {
        type: 'array',
        description: 'Filter by node types. Valid types: concept, module, class, function, workflow, devops, inbox.',
        items: {
          type: 'string',
          enum: ['concept', 'module', 'class', 'function', 'workflow', 'devops', 'inbox'],
        },
      },
    },
    required: ['query'],
  };

  private store: WikiNodeStore | null = null;

  get interruptBehavior(): ToolInterruptBehavior {
    return 'block';
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  /**
   * Initialize the tool with a wiki store
   */
  initializeStore(workingDirectory: string): void {
    this.store = new WikiNodeStore(workingDirectory);
  }

  async execute(input: Record<string, unknown>, workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();

    // Input validation
    const validation = validateWikiSearchInput(input);
    if (!validation.valid) {
      return {
        id,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { query, limit = 10, types } = validation.data;

    // Initialize store if needed
    if (!this.store && workingDirectory) {
      this.initializeStore(workingDirectory);
    }

    if (!this.store) {
      return {
        id,
        name: this.name,
        result: 'Wiki store not initialized. Please provide a working directory.',
        error: true,
      };
    }

    try {
      // Ensure wiki is initialized
      if (!this.store.isInitialized()) {
        this.store.initialize();
      }

      // Search nodes
      interface SearchOptions {
        query: string;
        limit: number;
        types?: string[];
      }
      const options: SearchOptions = {
        query,
        limit,
        types,
      };

      const results = this.performSearch(options);

      // Format results
      const formattedResults = results.map(r => ({
        title: r.node.title,
        path: r.node.path,
        type: r.node.type,
        score: r.score,
        matchType: r.matchType,
        summary: r.node.summary,
      }));

      if (formattedResults.length === 0) {
        return {
          id,
          name: this.name,
          result: `No wiki nodes found matching "${query}".`,
        };
      }

      return {
        id,
        name: this.name,
        result: `Found ${formattedResults.length} wiki node(s) matching "${query}":\n\n` +
          formattedResults.map((r, i) =>
            `${i + 1}. **${r.title}** (${r.type})\n   Path: ${r.path}\n   Match: ${r.matchType}${r.summary ? `\n   Summary: ${r.summary}` : ''}`
          ).join('\n\n'),
        metadata: {
          query,
          resultCount: formattedResults.length,
          results: formattedResults,
        },
      };
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return {
          id,
          name: this.name,
          result: `Security error: ${error.message}`,
          error: true,
        };
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        id,
        name: this.name,
        result: `Error searching wiki: ${errorMessage}`,
        error: true,
      };
    }
  }

  /**
   * Perform search across wiki nodes
   */
  private performSearch(options: { query: string; limit?: number; types?: string[] }): WikiSearchResult[] {
    const { query, limit = 10, types } = options;
    const lowerQuery = query.toLowerCase();

    // Get all nodes
    const allNodes = this.store!.listAllNodes();

    // Score and filter nodes
    const scored: WikiSearchResult[] = [];

    for (const node of allNodes) {
      // Filter by type if specified
      if (types && !types.includes(node.type)) {
        continue;
      }

      let score = 0;
      let matchType: WikiSearchResult['matchType'] = 'content';

      // Title match (highest priority)
      const titleLower = node.title.toLowerCase();
      if (titleLower === lowerQuery) {
        score = 100;
        matchType = 'title';
      } else if (titleLower.startsWith(lowerQuery)) {
        score = 80;
        matchType = 'title';
      } else if (titleLower.includes(lowerQuery)) {
        score = 60;
        matchType = 'title';
      }

      // Alias match
      if (score < 60) {
        for (const alias of node.aliases) {
          const aliasLower = alias.toLowerCase();
          if (aliasLower === lowerQuery) {
            score = 70;
            matchType = 'alias';
            break;
          } else if (aliasLower.includes(lowerQuery)) {
            score = Math.max(score, 50);
            matchType = 'alias';
          }
        }
      }

      // Tag match
      if (score < 50 && node.tags) {
        for (const tag of node.tags) {
          if (tag.toLowerCase().includes(lowerQuery)) {
            score = Math.max(score, 40);
            matchType = 'tag';
          }
        }
      }

      if (score > 0) {
        scored.push({
          node,
          score,
          matchType,
        });
      }
    }

    // Sort by score descending and limit results
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  renderToolResultMessage(result: ToolResult): RenderedToolMessage {
    if (result.error) {
      return {
        type: 'error',
        content: result.result,
        metadata: result.metadata,
      };
    }

    return {
      type: 'text',
      content: result.result,
      metadata: result.metadata,
    };
  }

  generateUserFacingDescription(input: unknown): string {
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      const query = obj.query as string | undefined;
      if (query) {
        return `wiki_search: "${query}"`;
      }
    }
    return 'wiki_search';
  }
}

/**
 * Create a WikiSearchTool instance
 */
export function createWikiSearchTool(workingDirectory?: string): WikiSearchTool {
  const tool = new WikiSearchTool();
  if (workingDirectory) {
    tool.initializeStore(workingDirectory);
  }
  return tool;
}

export const wikiSearchTool = new WikiSearchTool();
