/**
 * image_generate discoverability tests (plan image-gen).
 *
 * Verifies the tool is registered with exposeMode 'discoverable' in the
 * builtin registry: absent from the default tool surface, reachable via
 * the tool_search scanner, and visible again after discovery.
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinRegistry } from '../../builtin.js';
import { searchToolsFromRegistry } from '../../ToolSearchTool/searchTools.js';
import { extractToolNamesFromSearchResult } from '../../../agent/tool-search-discovery.js';
import { ToolSearchTool } from '../../ToolSearchTool/ToolSearchTool.js';
import { IMAGE_GENERATE_TOOL_NAME } from '../ImageGenerateTool.js';
import { isToolVisible, type ToolVisibilityConstraints } from '../../../agent-profile/ToolFilter.js';

const NO_CONSTRAINTS: ToolVisibilityConstraints = {
  disabledTools: [],
  allowedTools: [],
  profileDisallowedPatterns: [],
  profileAllowedPatterns: [],
};

function sampleToolSearchResult(name: string, exposure: string, summary: string, description: string): string {
  return [
    '<!-- duya-tool-search-result -->',
    '',
    '# Tool Search Results',
    '',
    `## Tool: \`${name}\``,
    '',
    `- **Exposure:** ${exposure}`,
    `- **Input summary:** ${summary}`,
    '',
    description,
    '',
  ].join('\n');
}

describe('image_generate discoverability', () => {
  it('is registered discoverable in the builtin registry', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTool(IMAGE_GENERATE_TOOL_NAME)).toBeDefined();
    expect(registry.getExposeMode(IMAGE_GENERATE_TOOL_NAME)).toBe('discoverable');
    expect(registry.getMeta(IMAGE_GENERATE_TOOL_NAME)?.inputSchemaSummary).toContain('prompt');
  });

  it('is hidden from the default tool surface', () => {
    const registry = createBuiltinRegistry();
    const visible = registry
      .getAllTools()
      .filter((t) => isToolVisible(t.name, registry.getExposeMode(t.name), new Set(), NO_CONSTRAINTS))
      .map((t) => t.name);
    expect(visible).not.toContain(IMAGE_GENERATE_TOOL_NAME);
  });

  it('is returned by the tool_search scanner for image-related queries', () => {
    const registry = createBuiltinRegistry();
    const results = searchToolsFromRegistry(registry, 'image', 10);
    const names = results.map((r) => r.name);
    expect(names).toContain(IMAGE_GENERATE_TOOL_NAME);

    const byName = searchToolsFromRegistry(registry, IMAGE_GENERATE_TOOL_NAME, 5);
    expect(byName[0]?.name).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(byName[0]?.exposeMode).toBe('discoverable');
    expect(byName[0]?.inputSchemaSummary).toBeTruthy();
  });

  it('becomes visible after the model discovers it via tool_search output', async () => {
    const registry = createBuiltinRegistry();
    const searchTool = new ToolSearchTool();
    searchTool.setSearchFn((q, l) => searchToolsFromRegistry(registry, q, l));

    const result = await searchTool.execute({ query: 'image', limit: 5 });
    const resultText = result.result;
    expect(resultText).toContain('duya-tool-search-result');

    const discovered = new Set(extractToolNamesFromSearchResult(resultText));
    expect(discovered).toContain(IMAGE_GENERATE_TOOL_NAME);

    expect(
      isToolVisible(
        IMAGE_GENERATE_TOOL_NAME,
        registry.getExposeMode(IMAGE_GENERATE_TOOL_NAME),
        discovered,
        NO_CONSTRAINTS,
      ),
    ).toBe(true);
  });

  it('search output format round-trips through the discovery scanner', () => {
    const sample = sampleToolSearchResult(
      IMAGE_GENERATE_TOOL_NAME,
      'discoverable',
      'prompt (required), size, quality',
      'Generate an image from a text prompt.',
    );
    expect(extractToolNamesFromSearchResult(sample)).toEqual([IMAGE_GENERATE_TOOL_NAME]);
  });
});
