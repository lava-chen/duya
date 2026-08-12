/**
 * packages/ai/test/deferred-tools.test.ts
 *
 * Plan 418 Phase 4 — deferred tools:
 * - getDeferredToolNames / splitDeferredTools
 * - toAnthropicMessages emits `tool_reference` blocks (inside tool_result)
 *   for on-demand loaded tools, with ordinary content moved to a sibling
 *   text block, and never re-references a tool twice.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { Message, Model } from '../src/types.js';
import {
  getDeferredToolNames,
  splitDeferredTools,
} from '../src/utils/deferred-tools.js';
import { toAnthropicMessages } from '../src/api/anthropic-messages.js';

const model: Model<'anthropic'> = {
  id: 'test-model',
  name: 'test',
  api: 'anthropic',
  providerId: 'test',
  baseUrl: 'https://test.example.com',
  reasoning: false,
  input: ['text'],
  contextWindow: 1000,
  maxTokens: 1000,
};

const toolMessage = (
  toolCallId: string,
  content: string,
  addedToolNames?: string[],
): Message => ({
  role: 'tool',
  tool_call_id: toolCallId,
  content,
  ...(addedToolNames ? { addedToolNames } : {}),
});

// ─── Collection + split ─────────────────────────────────────────────────────

describe('getDeferredToolNames', () => {
  it('collects addedToolNames from tool messages only', () => {
    const messages: Message[] = [
      toolMessage('t1', 'ok', ['canvas_manage']),
      { role: 'user', content: 'hi', addedToolNames: ['ignored'] },
      toolMessage('t2', 'ok', ['canvas_capture', 'canvas_manage']),
    ];
    const names = getDeferredToolNames(messages);
    expect([...names].sort()).toEqual(['canvas_capture', 'canvas_manage']);
  });

  it('returns an empty set when nothing was loaded on-demand', () => {
    expect(getDeferredToolNames([toolMessage('t1', 'ok')]).size).toBe(0);
    expect(getDeferredToolNames([]).size).toBe(0);
  });
});

describe('splitDeferredTools', () => {
  it('splits tools into immediate vs deferred, preserving tool shape', () => {
    const tools = [
      { name: 'Read', description: 'r', input_schema: {} },
      { name: 'canvas_manage', description: 'c', input_schema: {} },
    ];
    const { immediate, deferred } = splitDeferredTools(tools, new Set(['canvas_manage']));
    expect(immediate.map((t) => t.name)).toEqual(['Read']);
    expect(deferred.map((t) => t.name)).toEqual(['canvas_manage']);
    // Shape preserved for the request params builder.
    expect(immediate[0]).toHaveProperty('input_schema');
  });

  it('ignores deferred names not present in the tool list', () => {
    const { immediate, deferred } = splitDeferredTools(
      [{ name: 'Read', description: 'r', input_schema: {} }],
      new Set(['ghost']),
    );
    expect(immediate).toHaveLength(1);
    expect(deferred).toHaveLength(0);
  });
});

// ─── toAnthropicMessages tool_reference output ──────────────────────────────

describe('toAnthropicMessages deferred tool references', () => {
  const blockTypes = (m: MessageParam): string[] =>
    (Array.isArray(m.content) ? m.content : []).map((b) => (b as { type: string }).type);

  it('emits a tool_reference block inside tool_result with a sibling text block', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'canvas_manage', input: {} }],
      },
      toolMessage('t1', 'canvas updated', ['canvas_manage']),
    ];
    const out = toAnthropicMessages(messages, model, false, new Set(['canvas_manage']));

    const toolRound = out.find(
      (m) => Array.isArray(m.content) && (m.content as ContentBlockParam[]).some(
        (b) => b.type === 'tool_result',
      ),
    );
    expect(toolRound).toBeDefined();
    const content = (toolRound as MessageParam).content as ContentBlockParam[];
    expect(blockTypes(toolRound as MessageParam)).toEqual(['tool_result', 'text']);
    const resultBlock = content[0] as ContentBlockParam & { content: unknown };
    expect((resultBlock.content as ContentBlockParam[])[0]).toEqual({
      type: 'tool_reference',
      tool_name: 'canvas_manage',
    });
    // Ordinary tool output moved to the sibling text block.
    expect((content[1] as ContentBlockParam & { text: string }).text).toContain('canvas updated');
  });

  it('keeps standard tool_result blocks when the tool is not deferred', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      },
      toolMessage('t1', 'content here', ['Read']),
    ];
    const out = toAnthropicMessages(messages, model, false, new Set(['canvas_manage']));

    const toolRound = out.find(
      (m) => Array.isArray(m.content) && (m.content as ContentBlockParam[]).some(
        (b) => b.type === 'tool_result',
      ),
    );
    expect(blockTypes(toolRound as MessageParam)).toEqual(['tool_result']);
    const resultBlock = ((toolRound as MessageParam).content as ContentBlockParam[])[0] as ContentBlockParam & { content: unknown };
    expect(resultBlock.content).toBe('content here');
  });

  it('does not re-reference a deferred tool loaded in an earlier turn', () => {
    const messages: Message[] = [
      // Turn 1: tool discovered + used.
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'canvas_manage', input: {} }],
      },
      toolMessage('t1', 'ok', ['canvas_manage']),
      // Turn 2: same tool used again without a new discovery marker.
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'canvas_manage', input: {} }],
      },
      toolMessage('t2', 'ok again'),
    ];
    const out = toAnthropicMessages(messages, model, false, new Set(['canvas_manage']));

    // tool_reference blocks live inside tool_result.content.
    const references = out
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => {
        const blocks = m.content as ContentBlockParam[];
        return blocks
          .filter((b) => b.type === 'tool_result')
          .flatMap((b) => (b as ContentBlockParam & { content: unknown }).content as ContentBlockParam[])
          .filter((b) => b.type === 'tool_reference');
      });
    // Exactly one reference for the discovery round; the second use does not
    // re-reference (no addedToolNames marker).
    expect(references).toHaveLength(1);
  });

  it('dedupes repeated names inside a single tool result', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'canvas_manage', input: {} }],
      },
      toolMessage('t1', 'ok', ['canvas_manage', 'canvas_manage', 'canvas_capture']),
    ];
    const out = toAnthropicMessages(
      messages,
      model,
      false,
      new Set(['canvas_manage', 'canvas_capture']),
    );
    const references = out
      .filter((m) => Array.isArray(m.content))
      .flatMap((m) => {
        const blocks = m.content as ContentBlockParam[];
        return blocks
          .filter((b) => b.type === 'tool_result')
          .flatMap((b) => (b as ContentBlockParam & { content: unknown }).content as ContentBlockParam[])
          .filter((b) => b.type === 'tool_reference');
      });
    expect(references.map((r) => (r as { tool_name: string }).tool_name).sort())
      .toEqual(['canvas_capture', 'canvas_manage']);
  });
});
