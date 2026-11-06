/**
 * Plan 624 E1 — the OpenAI Responses prompt cache key.
 *
 * Two claims:
 *   - when a caller sets `promptCacheKey`, it reaches the wire as
 *     `prompt_cache_key`, and
 *   - when it is unset, the request carries no such field, because an
 *     OpenAI-compatible proxy is allowed to reject unknown keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createOpenAIResponsesClient } from '../src/api/openai-responses.js';
import type { Message, SSEEvent } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  lastParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = {
      create: async (params: Record<string, unknown>) => {
        mocks.lastParams = params;
        return (async function* () {
          // No events: these tests assert the request, not the stream.
        })();
      },
    };
    chat = {
      completions: {
        create: async () => {
          throw new Error('chat.completions.create not used in responses tests');
        },
      },
    };
  },
}));

function makeClient(promptCacheKey?: string) {
  return createOpenAIResponsesClient({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid/v1',
    model: 'gpt-test',
    apiFormat: 'openai-responses',
    providerId: 'test-provider',
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
  });
}

const MESSAGES: Message[] = [{ role: 'user', content: 'hi' }];

async function drain(events: AsyncIterable<SSEEvent>): Promise<void> {
  for await (const _event of events) {
    // consume
  }
}

describe('plan 624 — responses prompt cache key', () => {
  beforeEach(() => {
    mocks.lastParams = undefined;
  });

  it('sends prompt_cache_key when the caller set one', async () => {
    await drain(makeClient('session-abc').streamChat(MESSAGES));

    expect(mocks.lastParams?.prompt_cache_key).toBe('session-abc');
  });

  it('omits the field when the caller did not set one', async () => {
    await drain(makeClient().streamChat(MESSAGES));

    expect(mocks.lastParams).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(mocks.lastParams, 'prompt_cache_key')).toBe(false);
  });
});
