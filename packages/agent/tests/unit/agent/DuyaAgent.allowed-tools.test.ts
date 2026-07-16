import { describe, expect, it } from 'vitest';
import { filterToolsByAllowedTools } from '../../../src/agent/DuyaAgent.js';
import type { Tool } from '../../../src/types.js';

const tools: Tool[] = ['read', 'grep', 'glob', 'write'].map((name) => ({
  name,
  description: name,
  input_schema: { type: 'object' },
}));

describe('DuyaAgent allowedTools filtering contract', () => {
  it('keeps the lowercase minimal toolset and excludes write tools', () => {
    expect(filterToolsByAllowedTools(tools, ['read', 'grep', 'glob']).map((tool) => tool.name))
      .toEqual(['read', 'grep', 'glob']);
  });

  it('does not silently match display-cased tool names', () => {
    expect(filterToolsByAllowedTools(tools, ['Read', 'Grep', 'Glob'])).toEqual([]);
  });
});
