import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor, ToolMeta } from '../registry.js';

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_SEARCH_RESULT_MARKER = '<!-- duya-tool-search-result -->';

export const DESCRIPTION = `Search available tools by name, description, keyword, or category.
Use when you need a tool for a specific operation but don't see it listed in this turn.

Each result states what the tool does and may include a concise input summary. The complete schema of each match is delivered on the next model turn: by default it is appended to the conversation tail and invoked with \`tool_invoke\`; legacy array delivery instead adds the tool to the tool list. Under catalog exposure the tool stays out of the tool list — read it with \`tool_schema\` (MCP servers by name, built-ins under the \`builtin\` namespace), then invoke it with \`tool_invoke\`. This searches tools, not skills: use the Skills catalog and the Skill tool to load a skill.`;

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
        return [
          `## Tool: \`${result.name}\``,
          '',
          result.description.trim(),
          '',
          '_The complete tool schema follows on the next model turn; invoke it with `tool_invoke`._',
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
