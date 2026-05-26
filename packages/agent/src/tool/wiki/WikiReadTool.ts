/**
 * WikiReadTool - Read wiki node content
 * Restricted to wiki-llm/ root directory with path security
 */

import * as path from 'path';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../../types.js';
import type { RenderedToolMessage, ToolInterruptBehavior } from '../types.js';
import { WikiNodeStore, PathSecurityError } from '../../wiki-agent/WikiNodeStore.js';
import type { WikiReadResult } from '../../wiki-agent/types.js';

// ============================================================
// Input Types
// ============================================================

export interface WikiReadInput {
  path: string;
}

// ============================================================
// Input Validation
// ============================================================

export function validateWikiReadInput(input: unknown): { valid: true; data: WikiReadInput } | { valid: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { valid: false, error: 'Input must be an object' };
  }

  const obj = input as Record<string, unknown>;

  if (!obj.path || typeof obj.path !== 'string') {
    return { valid: false, error: 'path must be a non-empty string' };
  }

  if (obj.path.trim().length === 0) {
    return { valid: false, error: 'path cannot be empty' };
  }

  // Validate path format (no directory traversal attempts)
  const normalizedPath = obj.path.replace(/\\/g, '/');
  if (normalizedPath.includes('..')) {
    return { valid: false, error: 'path cannot contain ".." (directory traversal)' };
  }

  // Must be within wiki-llm directory
  if (!normalizedPath.startsWith('wiki-llm/') && !normalizedPath.startsWith('wiki-llm\\')) {
    return { valid: false, error: 'path must be within wiki-llm/ directory' };
  }

  return {
    valid: true,
    data: {
      path: obj.path as string,
    },
  };
}

// ============================================================
// Tool Implementation
// ============================================================

export class WikiReadTool extends BaseTool {
  readonly name = 'wiki_read';
  readonly description = 'Read the content of a wiki node. The path must be within the wiki-llm/ directory. Use wiki_search first to find the correct path.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path to the wiki node file (e.g., "wiki-llm/concepts/architecture.md"). Must be within wiki-llm/ directory.',
      },
    },
    required: ['path'],
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
    const validation = validateWikiReadInput(input);
    if (!validation.valid) {
      return {
        id,
        name: this.name,
        result: `Input validation failed: ${validation.error}`,
        error: true,
      };
    }

    const { path: nodePath } = validation.data;

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

      // Resolve full path
      const fullPath = path.join(workingDirectory || '', nodePath);

      // Read the node
      const node = this.store.readNode(fullPath);

      // Format result
      const result: WikiReadResult = {
        node,
        content: node.content,
      };

      return {
        id,
        name: this.name,
        result: this.formatResult(result),
        metadata: {
          path: nodePath,
          title: node.title,
          type: node.type,
          aliases: node.aliases,
          tags: node.tags,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          backlinks: node.backlinks,
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

      if (errorMessage.includes('not found') || errorMessage.includes('ENOENT')) {
        return {
          id,
          name: this.name,
          result: `Wiki node not found: ${nodePath}. Use wiki_search to find available nodes.`,
          error: true,
        };
      }

      return {
        id,
        name: this.name,
        result: `Error reading wiki node: ${errorMessage}`,
        error: true,
      };
    }
  }

  /**
   * Format the read result for display
   */
  private formatResult(result: WikiReadResult): string {
    const { node, content } = result;

    const lines: string[] = [
      `# ${node.title}`,
      '',
      `**Type:** ${node.type}`,
      `**Path:** ${node.path}`,
    ];

    if (node.aliases.length > 0) {
      lines.push(`**Aliases:** ${node.aliases.join(', ')}`);
    }

    if (node.tags.length > 0) {
      lines.push(`**Tags:** ${node.tags.join(', ')}`);
    }

    if (node.backlinks.length > 0) {
      lines.push(`**Backlinks:** ${node.backlinks.join(', ')}`);
    }

    lines.push(
      '',
      '---',
      '',
      content
    );

    return lines.join('\n');
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
      const nodePath = obj.path as string | undefined;
      if (nodePath) {
        return `wiki_read: ${nodePath}`;
      }
    }
    return 'wiki_read';
  }
}

/**
 * Create a WikiReadTool instance
 */
export function createWikiReadTool(workingDirectory?: string): WikiReadTool {
  const tool = new WikiReadTool();
  if (workingDirectory) {
    tool.initializeStore(workingDirectory);
  }
  return tool;
}

export const wikiReadTool = new WikiReadTool();
