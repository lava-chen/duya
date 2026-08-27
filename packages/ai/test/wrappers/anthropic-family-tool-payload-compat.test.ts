/**
 * packages/ai/test/wrappers/anthropic-family-tool-payload-compat.test.ts
 *
 * Plan 451 Phase 1: tool-payload compatibility wrapper.
 */

import { describe, it, expect } from 'vitest';
import {
  anthropicFamilyToolPayloadCompat,
  applyToolResultTransport,
  resolveToolResultTransport,
  isDeepSeekAnthropicEndpoint,
} from '../../src/providers/wrappers/anthropic-family-tool-payload-compat.js';
import type { Message, ToolResultTransport } from '../../src/types.js';
import type { Model, SSEEvent } from '../../src/types.js';
import type { ProviderStreams } from '../../src/providers/lazy.js';

const fakeModel = (overrides: Partial<Model> = {}): Model =>
  ({
    id: 'm',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    compat: undefined,
    ...overrides,
  }) as Model;

// Sample message list with a tool_result content block — the canonical
// shape that some Anthropic-compatible endpoints reject.
const sampleMessages: Message[] = [
  { role: 'user', content: 'list files' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 't1',
    name: 'Bash',
    content: 'README.md\npackage.json',
  },
];

describe('isDeepSeekAnthropicEndpoint', () => {
  it('returns true for api.deepseek.com /anthropic', () => {
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/anthropic')).toBe(true);
  });
  it('returns true for api.deepseek.com (with path)', () => {
    expect(isDeepSeekAnthropicEndpoint('https://api.deepseek.com/anthropic/v1')).toBe(true);
  });
  it('returns false for other Anthropic endpoints', () => {
    expect(isDeepSeekAnthropicEndpoint('https://api.anthropic.com')).toBe(false);
    expect(isDeepSeekAnthropicEndpoint('https://api.minimax.io/anthropic')).toBe(false);
  });
  it('returns false for empty/undefined', () => {
    expect(isDeepSeekAnthropicEndpoint(undefined)).toBe(false);
    expect(isDeepSeekAnthropicEndpoint('')).toBe(false);
  });
});

describe('resolveToolResultTransport', () => {
  it('returns the compat override when set (highest precedence)', () => {
    const result = resolveToolResultTransport('https://api.anthropic.com', {
      toolResultTransport: 'none',
    });
    expect(result).toBe('none');
  });
  it('returns text-user-message for DeepSeek endpoint when compat unset', () => {
    expect(
      resolveToolResultTransport('https://api.deepseek.com/anthropic', undefined),
    ).toBe('text-user-message');
  });
  it('returns tool-result-block by default', () => {
    expect(resolveToolResultTransport('https://api.anthropic.com', undefined)).toBe(
      'tool-result-block',
    );
  });
  it('compat overrides URL inference', () => {
    expect(
      resolveToolResultTransport('https://api.deepseek.com/anthropic', {
        toolResultTransport: 'tool-result-block',
      }),
    ).toBe('tool-result-block');
  });
});

describe('applyToolResultTransport', () => {
  it('returns messages unchanged for tool-result-block', () => {
    const out = applyToolResultTransport(
      sampleMessages,
      'https://api.anthropic.com',
      undefined,
    );
    expect(out).toBe(sampleMessages); // identity reference — same array
  });
  it('textifies tool blocks when transport is text-user-message', () => {
    const out = applyToolResultTransport(
      sampleMessages,
      'https://api.deepseek.com/anthropic',
      undefined,
    );
    expect(out).not.toBe(sampleMessages);
    // The 'tool' message becomes a 'user' message containing a [Tool result: ...] block.
    const toolLike = out.find((m) => m.role === 'user' && /Tool result/.test(String(m.content)));
    expect(toolLike).toBeDefined();
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
  });
  it('drops tool messages when transport is none', () => {
    const out = applyToolResultTransport(sampleMessages, 'https://api.x', {
      toolResultTransport: 'none' satisfies ToolResultTransport,
    });
    expect(out.find((m) => m.role === 'tool')).toBeUndefined();
    expect(out.length).toBe(2); // user + assistant, no tool
  });
});

describe('anthropicFamilyToolPayloadCompat (stream wrapper)', () => {
  function makeInner(captured: { received: unknown }): ProviderStreams {
    return {
      stream: (_model, opts) => {
        captured.received = opts.messages;
        return (async function* () {
          yield { type: 'text', data: 'ok' } satisfies SSEEvent;
          return null;
        })();
      },
    };
  }

  it('forwards messages unchanged for the default transport', async () => {
    const captured = { received: undefined as unknown };
    const wrapped = anthropicFamilyToolPayloadCompat()(makeInner(captured));
    const events: SSEEvent[] = [];
    for await (const e of wrapped.stream(
      fakeModel({ baseUrl: 'https://api.anthropic.com' }),
      { messages: sampleMessages },
    )) events.push(e);
    expect(events).toEqual([{ type: 'text', data: 'ok' }]);
    expect(captured.received).toBe(sampleMessages);
  });

  it('textifies messages before the inner stream when transport is text-user-message', async () => {
    const captured = { received: undefined as unknown };
    const wrapped = anthropicFamilyToolPayloadCompat()(makeInner(captured));
    const gen = wrapped.stream(
      fakeModel({ baseUrl: 'https://api.deepseek.com/anthropic' }),
      { messages: sampleMessages },
    );
    // Drain to trigger inner.stream.
    for await (const _e of gen) { /* drain */ }
    const inner = captured.received as Message[];
    expect(inner).toBeDefined();
    expect(inner.find((m) => m.role === 'tool')).toBeUndefined();
    expect(inner.some((m) => m.role === 'user' && /Tool result/.test(String(m.content)))).toBe(
      true,
    );
  });

  it('passes through unchanged when messages is not an array', async () => {
    const captured = { received: undefined as unknown };
    const wrapped = anthropicFamilyToolPayloadCompat()(makeInner(captured));
    const sentinel = { weird: 'shape' };
    for await (const _e of wrapped.stream(fakeModel(), { messages: sentinel as unknown[] })) { /* drain */ }
    expect(captured.received).toBe(sentinel);
  });
});