/** Generate a concise project summary from the caller's workspace. */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../contracts/tool.js';
import { BRIEF_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { NodeBriefWorkspacePort, type BriefWorkspacePort } from './ports.js';

export class BriefTool extends BaseTool {
  readonly name = BRIEF_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  constructor(private readonly workspace: BriefWorkspacePort = new NodeBriefWorkspacePort()) {
    super();
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  /** Recursively collect the visible directory structure, up to three levels. */
  async getDirStructure(dir: string, maxDepth = 3, currentDepth = 0): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];
    return this.getRelativeDirStructure(dir, '', maxDepth, currentDepth);
  }

  /** Read package.json to get project info. Missing or invalid metadata is optional. */
  async getPackageInfo(workspaceRoot = '.'): Promise<Record<string, unknown> | null> {
    try {
      const content = await this.workspace.readTextFile(workspaceRoot, 'package.json');
      const parsed: unknown = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  async execute(
    _input: Record<string, unknown>,
    workingDirectory?: string,
    _context?: ToolUseContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const workspaceRoot = workingDirectory ?? '.';

    try {
      const structure = await this.getDirStructure(workspaceRoot);
      const packageInfo = await this.getPackageInfo(workspaceRoot);
      const result = {
        project: {
          name: packageInfo?.['name'] || 'unknown',
          version: packageInfo?.['version'] || 'unknown',
          description: packageInfo?.['description'] || 'No description',
        },
        structure: structure.slice(0, 100),
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

  private async getRelativeDirStructure(
    workspaceRoot: string,
    relativePath: string,
    maxDepth: number,
    currentDepth: number,
  ): Promise<string[]> {
    if (currentDepth >= maxDepth) return [];

    const entries = await this.workspace.readDirectory(workspaceRoot, relativePath);
    const lines: string[] = [];

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }

      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const prefix = '  '.repeat(currentDepth);

      if (entry.isDirectory) {
        lines.push(`${prefix}${entry.name}/`);
        lines.push(...await this.getRelativeDirStructure(workspaceRoot, childPath, maxDepth, currentDepth + 1));
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }

    return lines;
  }
}

export const briefTool = new BriefTool();
