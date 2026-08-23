import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenAICompletionsClient } from '../src/api/openai-completions.js';
import type { Message, SSEEvent } from '../src/types.js';

// Plan 440 P0: a refusing model streams its reply through `delta.refusal`
// (streaming) / `message.refusal` (non-streaming) with the content field
// null. Before plan 440 both paths produced a silently empty assistant
// message. These tests drive the real streamChat/chat through a mocked
// OpenAI SDK module.

const mocks = vi.hoisted(() => ({
  state: {} as {
    /** Returned by chat.completions.create when stream:true. */
    chatStream?: unknown;
    /** Returned by chat.completions.create for the non-streaming chat(). */
    chatResponse?: unknown;
  },
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: async () => {
          if (mocks.state.chatResponse !== undefined) return mocks.state.chatResponse;
          return mocks.state.chatStream;
        },
      },
    };
    responses = {
      create: async () => {
        throw new Error('responses.create not used in refusal tests');
      },
    };
  },
}));

function makeClient() {
  return createOpenAICompletionsClient({
    apiKey: 'test-key',
    baseURL: 'https://example.invalid/v1',
    model: 'gpt-test',
    apiFormat: 'openai-chat',
    providerId: 'test-provider',
  });
}

async function collect(events: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const MESSAGES: Message[] = [{ role: 'user', content: 'hi' }];

describe('openai-chat refusal parsing (plan 440 P0)', () => {
  beforeEach(() => {
    mocks.state.chatStream = undefined;
    mocks.state.chatResponse = undefined;
  });

  it('surfaces streaming delta.refusal as text instead of an empty reply', async () => {
    mocks.state.chatStream = (async function* () {
      yield { choices: [{ delta: { refusal: 'I cannot help with that.' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
    })();
    const events = await collect(makeClient().streamChat(MESSAGES));

    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as { data: string }).data)
      .join('');
    expect(text).toBe('I cannot help with that.');
    expect(events.some(e => e.type === 'error')).toBe(false);
  });

  it('surfaces non-streaming message.refusal from chat()', async () => {
    mocks.state.chatResponse = {
      choices: [{ message: { content: null, refusal: 'No.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const result = await makeClient().chat(MESSAGES);
    expect(result.content).toBe('No.');
  });

  it('keeps normal delta.content flowing unchanged (regression)', async () => {
    mocks.state.chatStream = (async function* () {
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: ' world' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })();
    const events = await collect(makeClient().streamChat(MESSAGES));

    const text = events
      .filter(e => e.type === 'text')
      .map(e => (e as { data: string }).data)
      .join('');
    expect(text).toBe('Hello world');
  });

  it('keeps normal message.content in chat() unchanged (regression)', async () => {
    mocks.state.chatResponse = {
      choices: [{ message: { content: 'plain reply', refusal: null } }],
    };
    const result = await makeClient().chat(MESSAGES);
    expect(result.content).toBe('plain reply');
  });
});
