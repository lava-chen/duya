import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompletionsClient } from '../src/api/openai-completions.js';
import { minimaxOpenAIModels } from '../src/providers/minimax-openai.js';
import type { SSEEvent } from '../src/types.js';

function sseChunk(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('MiniMax OpenAI-compatible streaming thinking', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    server = createServer((_, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const chunks = [
        { delta: { content: '<think>Let' } },
        { delta: { content: ' me think' } },
        { delta: { content: '</think>Hello' } },
        { delta: { content: ' world' } },
        { delta: {}, finish_reason: 'stop' },
      ];

      for (const [i, { delta, finish_reason }] of chunks.entries()) {
        res.write(
          sseChunk({
            id: `chatcmpl-test-${i}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'MiniMax-M3',
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finish_reason ?? null,
              },
            ],
          }),
        );
      }

      res.write(sseChunk('[DONE]'));
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('extracts <think> tags from content as thinking when preset is think-tag-fallback', async () => {
    const client = createOpenAICompletionsClient({
      apiKey: 'test-key',
      baseURL: `http://localhost:${port}/v1`,
      model: 'MiniMax-M3',
      providerId: 'minimax-openai',
      modelCapabilities: minimaxOpenAIModels[0].compat,
    });

    const events: SSEEvent[] = [];
    for await (const event of client.streamChat([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const thinkingEvents = events.filter((e) => e.type === 'thinking');
    const textEvents = events.filter((e) => e.type === 'text');

    expect(thinkingEvents.map((e) => e.data).join('')).toBe('Let me think');
    expect(textEvents.map((e) => e.data).join('')).toBe('Hello world');
  });
});
