import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor, ToolMeta } from '../registry.js';

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_SEARCH_RESULT_MARKER = '<!-- duya-tool-search-result -->';

export const DESCRIPTION = `Search available tools by name, description, keyword, or category.
Use when you need a tool for a specific operation but don't see it listed in this turn.

Each returned result includes a 'description' (what the tool does) and 'inputSchemaSummary' (a
concise description of the required/optional parameters). You can call the tool directly using
those parameters — no further setup required. Only the core file, search, task delegation,
and platform-native shell tools are listed directly. Browser, memory, session, mode, canvas,
research, wiki, inter-agent, CLI, generative UI, vision, module, skill-management, and MCP tools
can be discovered on-demand via this tool. Plan 241 Phase 1: inputSchemaSummary
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
        result: `${TOOL_SEARCH_RESULT_MARKER}\n\n# Tool Search Error\n\nThe \`query\` parameter is required.`,
        error: true,
      };
    }

    if (!this.searchFn) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `${TOOL_SEARCH_RESULT_MARKER}\n\n# Tool Search Error\n\nTool search is not configured.`,
        error: true,
      };
    }

    try {
      const results = this.searchFn(query, Math.min(limit, 20));
      const sections = results.map((result) => {
        const metadata = [
          `- **Category:** ${result.category}`,
          `- **Exposure:** ${result.exposeMode ?? 'always'}`,
          result.inputSchemaSummary
            ? `- **Input summary:** ${result.inputSchemaSummary}`
            : null,
        ].filter((line): line is string => line !== null);

        return [
          `## Tool: \`${result.name}\``,
          '',
          ...metadata,
          '',
          result.description.trim(),
          '',
          '_The complete tool schema and any tool-specific usage guide will be available on the next model turn._',
        ].join('\n');
      });
      const body = sections.length > 0
        ? sections.join('\n\n---\n\n')
        : '_No matching tools found._';

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          TOOL_SEARCH_RESULT_MARKER,
          '',
          '# Tool Search Results',
          '',
          `**Query:** \`${query.replace(/`/g, '\\`')}\``,
          `**Matches:** ${results.length}`,
          '',
          body,
        ].join('\n'),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed';
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: `${TOOL_SEARCH_RESULT_MARKER}\n\n# Tool Search Error\n\n${message}`,
        error: true,
      };
    }
  }
}

export const toolSearchTool = new ToolSearchTool();