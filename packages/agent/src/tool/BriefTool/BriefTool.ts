/**
 * BriefTool - Generate a brief summary of the codebase
 * Adapted from claude-code-haha for duya
 */

import { execa } from 'execa';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { BRIEF_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

export class BriefTool implements Tool, ToolExecutor {
  readonly name = BRIEF_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  /**
   * Recursively get directory structure
   */
  async getDirStructure(dir: string, maxDepth = 3, currentDepth = 0): Promise<string[]> {
    if (currentDepth >= maxDepth) {
      return [];
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];

    for (const entry of entries) {
      // Skip hidden files, node_modules, and build directories
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
        continue;
      }

      const fullPath = join(dir, entry.name);
      const prefix = '  '.repeat(currentDepth);

      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        const subLines = await this.getDirStructure(fullPath, maxDepth, currentDepth + 1);
        lines.push(...subLines);
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }

    return lines;
  }

  /**
   * Read package.json to get project info
   */
  async getPackageInfo(): Promise<Record<string, unknown> | null> {
    try {
      const { readFile } = await import('fs/promises');
      const content = await readFile('package.json', 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async execute(): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      // Get directory structure
      const structure = await this.getDirStructure('.');

      // Get package.json info
      const packageInfo = await this.getPackageInfo();

      const result = {
        project: {
          name: packageInfo?.['name'] || 'unknown',
          version: packageInfo?.['version'] || 'unknown',
          description: packageInfo?.['description'] || 'No description',
        },
        structure: structure.slice(0, 100), // Limit to first 100 lines
        note: structure.length > 100 ? `... and ${structure.length - 100} more items` : undefined,
        durationMs: Date.now() - startTime,
      };

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to generate brief',
        }),
        error: true,
      };
    }
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const briefTool = new BriefTool();
