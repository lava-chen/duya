/**
 * Tests for Plan 241 Phase 3: tool_search discovery scanner.
 *
 * Covers:
 *   - extractToolNamesFromSearchResult: parse JSON, extract names, graceful
 *     fallback on bad input
 *   - harvestDiscoveredTools: scan tool_result messages, populate Set,
 *     report new-name count, skip already-seen names
 */

import { describe, it, expect } from 'vitest';
import {
  extractToolNamesFromSearchResult,
  harvestDiscoveredTools,
} from '../../src/agent/tool-search-discovery.js';
import type { Message, MessageContent } from '../../src/types.js';

describe('extractToolNamesFromSearchResult', () => {
  it('extracts names from a well-formed tool_search result payload', () => {
    const json = JSON.stringify({
      query: 'canvas',
      results: [
        { name: 'canvas_manage', description: '...', category: 'canvas' },
        { name: 'canvas_capture', description: '...', category: 'canvas' },
      ],
      count: 2,
    });
    expect(extractToolNamesFromSearchResult(json)).toEqual(['canvas_manage', 'canvas_capture']);
  });

  it('returns an empty array for empty input', () => {
    expect(extractToolNamesFromSearchResult('')).toEqual([]);
  });

  it('returns an empty array on malformed JSON', () => {
    expect(extractToolNamesFromSearchResult('{not json')).toEqual([]);
    expect(extractToolNamesFromSearchResult('null')).toEqual([]);
  });

  it('returns an empty array when results is missing', () => {
    expect(extractToolNamesFromSearchResult(JSON.stringify({ query: 'x' }))).toEqual([]);
  });

  it('skips entries without a string name', () => {
    const json = JSON.stringify({
      results: [
        { name: 'good', description: '...' },
        { description: 'no name field' },
        { name: 42 }, // not a string
      ],
    });
    expect(extractToolNamesFromSearchResult(json)).toEqual(['good']);
  });
});

describe('harvestDiscoveredTools', () => {
  function makeToolResultMessage(payload: object, role: 'user' | 'tool' = 'user'): Message {
    if (role === 'user') {
      // Anthropic-style tool_result content block
      const content: MessageContent[] = [
        {
          type: 'tool_result',
          tool_use_id: 'tool_search_0',
          content: JSON.stringify(payload),
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
    // OpenAI-style 'tool' role with string content
    return {
      id: 'msg-2',
      role: 'tool',
      content: JSON.stringify(payload),
      timestamp: 0,
    };
  }

  it('adds names from a tool_result user-role message', () => {
    const messages = [
      makeToolResultMessage({
        results: [
          { name: 'canvas_manage' },
          { name: 'canvas_capture' },
        ],
      }),
    ];
    const acc = new Set<string>();
    const added = harvestDiscoveredTools(messages, acc);
    expect(added).toBe(2);
    expect(acc.has('canvas_manage')).toBe(true);
    expect(acc.has('canvas_capture')).toBe(true);
  });

  it('adds names from a tool-role message with string content', () => {
    const messages = [
      makeToolResultMessage({ results: [{ name: 'research_memory:propose' }] }, 'tool'),
    ];
    const acc = new Set<string>();
    const added = harvestDiscoveredTools(messages, acc);
    expect(added).toBe(1);
    expect(acc.has('research_memory:propose')).toBe(true);
  });

  it('does not double-count names already in the accumulator', () => {
    const acc = new Set<string>(['canvas_manage']);
    const messages = [
      makeToolResultMessage({
        results: [{ name: 'canvas_manage' }, { name: 'canvas_capture' }],
      }),
    ];
    const added = harvestDiscoveredTools(messages, acc);
    expect(added).toBe(1);
    expect(acc.size).toBe(2);
  });

  it('returns 0 when no tool_result payloads match', () => {
    const messages = [
      makeToolResultMessage({ unrelated: 'shape' }),
    ];
    const acc = new Set<string>();
    const added = harvestDiscoveredTools(messages, acc);
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
      makeToolResultMessage({ results: [{ name: 'a' }] }),
      makeToolResultMessage({ results: [{ name: 'b' }, { name: 'c' }] }, 'tool'),
    ];
    const acc = new Set<string>();
    const added = harvestDiscoveredTools(messages, acc);
    expect(added).toBe(3);
    expect(acc.size).toBe(3);
  });
});