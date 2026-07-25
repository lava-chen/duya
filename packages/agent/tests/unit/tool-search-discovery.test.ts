import { describe, it, expect } from 'vitest';
import {
  extractToolNamesFromSearchResult,
  getDiscoveredToolPrompts,
  harvestDiscoveredTools,
} from '../../src/agent/tool-search-discovery.js';
import type { Message, MessageContent, Tool } from '../../src/types.js';
import { ToolRegistry } from '../../src/tool/registry.js';

const marker = '<!-- duya-tool-search-result -->';

function markdownFor(...toolNames: string[]): string {
  return [marker, ...toolNames.map((name) => `## Tool: \`${name}\``)].join('\n');
}

describe('extractToolNamesFromSearchResult', () => {
  it('extracts names from marked Markdown headings', () => {
    expect(extractToolNamesFromSearchResult(
      markdownFor('canvas_manage', 'canvas_capture'),
    )).toEqual(['canvas_manage', 'canvas_capture']);
  });

  it('ignores empty, unmarked, and legacy JSON input', () => {
    expect(extractToolNamesFromSearchResult('')).toEqual([]);
    expect(extractToolNamesFromSearchResult('## Tool: `browser`')).toEqual([]);
    expect(extractToolNamesFromSearchResult('{"results":[{"name":"browser"}]}')).toEqual([]);
  });

  it('deduplicates repeated tool headings', () => {
    expect(extractToolNamesFromSearchResult(markdownFor('browser', 'browser')))
      .toEqual(['browser']);
  });
});

describe('getDiscoveredToolPrompts', () => {
  it('returns the usage guide for a discovered tool executor', () => {
    const registry = new ToolRegistry();
    const definition = {
      name: 'browser',
      description: 'Browse pages',
      input_schema: { type: 'object', properties: {} },
    } as unknown as Tool;
    registry.register(definition, {
      execute: async () => ({ id: 'x', name: 'browser', result: '' }),
      getPrompt: () => '## Browser Tool\n\nUse snapshots and refs.',
    });

    expect(getDiscoveredToolPrompts(registry, new Set(['browser'])))
      .toEqual(['## Browser Tool\n\nUse snapshots and refs.']);
  });

  it('skips tools without a usage guide', () => {
    const registry = new ToolRegistry();
    const definition = {
      name: 'plain',
      description: 'Plain tool',
      input_schema: { type: 'object', properties: {} },
    } as unknown as Tool;
    registry.register(definition, {
      execute: async () => ({ id: 'x', name: 'plain', result: '' }),
    });

    expect(getDiscoveredToolPrompts(registry, new Set(['plain']))).toEqual([]);
  });
});

describe('harvestDiscoveredTools', () => {
  function makeToolResultMessage(toolNames: string[], role: 'user' | 'tool' = 'user'): Message {
    const payload = markdownFor(...toolNames);
    if (role === 'user') {
      const content: MessageContent[] = [
        {
          type: 'tool_result',
          tool_use_id: 'tool_search_0',
          content: payload,
          is_error: false,
        } as MessageContent,
      ];
      return {
        id: 'msg-1',
        role: 'user',
        content,
        timestamp: 0,
      };
    }
    return {
      id: 'msg-2',
      role: 'tool',
      content: payload,
      timestamp: 0,
    };
  }

  it('adds names from a user-role tool_result message', () => {
    const acc = new Set<string>();
    const added = harvestDiscoveredTools([
      makeToolResultMessage(['canvas_manage', 'canvas_capture']),
    ], acc);
    expect(added).toBe(2);
    expect([...acc]).toEqual(['canvas_manage', 'canvas_capture']);
  });

  it('adds names from a tool-role string message', () => {
    const acc = new Set<string>();
    const added = harvestDiscoveredTools([
      makeToolResultMessage(['research_memory:propose'], 'tool'),
    ], acc);
    expect(added).toBe(1);
    expect(acc.has('research_memory:propose')).toBe(true);
  });

  it('does not double-count names already accumulated', () => {
    const acc = new Set<string>(['canvas_manage']);
    const added = harvestDiscoveredTools([
      makeToolResultMessage(['canvas_manage', 'canvas_capture']),
    ], acc);
    expect(added).toBe(1);
    expect(acc.size).toBe(2);
  });

  it('returns zero when no marked tool headings exist', () => {
    const acc = new Set<string>();
    const added = harvestDiscoveredTools([
      {
        id: 'msg-unrelated',
        role: 'tool',
        content: 'ordinary tool output',
        timestamp: 0,
      },
    ], acc);
    expect(added).toBe(0);
    expect(acc.size).toBe(0);
  });

  it('handles a mixed batch of messages', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: 'just text, no tool_result',
        timestamp: 0,
      },
      makeToolResultMessage(['a']),
      makeToolResultMessage(['b', 'c'], 'tool'),
    ];
    const acc = new Set<string>();
    const added = harvestDiscoveredTools(messages, acc);
    expect(added).toBe(3);
    expect([...acc]).toEqual(['a', 'b', 'c']);
  });
});
