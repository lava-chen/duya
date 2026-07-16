import { describe, expect, it } from 'vitest';
import { filterOpenAICompatibleTools } from '../../../src/llm/openai-client.js';
import type { Tool } from '../../../src/types.js';

function tool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: {} },
  };
}

describe('filterOpenAICompatibleTools', () => {
  it('preserves names accepted by OpenAI-compatible providers', () => {
    const tools = filterOpenAICompatibleTools([
      tool('read_file'),
      tool('mcp-tool_2'),
    ]);

    expect(tools.map((item) => item.name)).toEqual(['read_file', 'mcp-tool_2']);
  });

  it('excludes externally supplied names that would reject the request', () => {
    const tools = filterOpenAICompatibleTools([
      tool('valid_tool'),
      tool('server.tool'),
      tool('server:tool'),
      tool('tool with spaces'),
    ]);

    expect(tools.map((item) => item.name)).toEqual(['valid_tool']);
  });
});
