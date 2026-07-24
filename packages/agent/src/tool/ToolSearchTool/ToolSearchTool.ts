import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor, ToolMeta } from '../registry.js';

export const TOOL_SEARCH_NAME = 'tool_search';

export const DESCRIPTION = `Search available tools by name, description, keyword, or category.
Use when you need a tool for a specific operation but don't see it listed in this turn.

Each returned result includes a 'description' (what the tool does) and 'inputSchemaSummary' (a
concise description of the required/optional parameters). You can call the tool directly using
those parameters — no further setup required. Common high-frequency tools (Read, Bash, Edit,
Glob, Grep, Agent, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode, EnterWorktree,
ExitWorktree, SwitchMode, browser, Memory, SessionSearch, ToolSearch) are listed directly;
specialized tools (canvas_*, research_memory:*, wiki_*, MessageSession, Brief, duya_cli,
show_widget, vision_analyze, read_module, anchor_memory, skill_manage, ListMcpResources,
ReadMcpResource) can be discovered on-demand via this tool. Plan 241 Phase 1: inputSchemaSummary
may be null when the registry has not yet persisted schema metadata (will be filled in Phase 2).`;

export class ToolSearchTool implements Tool, ToolExecutor {
  readonly name = TOOL_SEARCH_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — matches tool name, description, keywords, or category',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 10)',
      },
    },
    required: ['query'],
  };

  private searchFn?: (query: string, limit: number) => ToolMeta[];

  setSearchFn(fn: (query: string, limit: number) => ToolMeta[]): void {
    this.searchFn = fn;
  }

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    } as Tool;
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof input.query === 'string' ? input.query : '';
    const limit = typeof input.limit === 'number' ? input.limit : 10;

    if (!query.trim()) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'query is required' }),
        error: true,
      };
    }

    if (!this.searchFn) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'Tool search not configured' }),
        error: true,
      };
    }

    try {
      const results = this.searchFn(query, Math.min(limit, 20));
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          query,
          results: results.map(r => ({
            name: r.name,
            description: r.description,
            category: r.category,
            inputSchemaSummary: r.inputSchemaSummary ?? null,
            exposeMode: r.exposeMode ?? null,
          })),
          count: results.length,
        }),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: error instanceof Error ? error.message : 'Search failed',
        }),
        error: true,
      };
    }
  }
}

export const toolSearchTool = new ToolSearchTool();