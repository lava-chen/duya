/**
 * Reproduction test for Anthropic API 2013 error:
 * "invalid params, tool call result does not follow tool call"
 *
 * We construct a real AnthropicClient, but intercept fetch so the request
 * never goes to the network. We then assert on the exact `messages` array
 * that would have been POSTed to the API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient } from '../../../src/llm/anthropic-client.js';
import type { Message } from '../../../src/types.js';

const MINIMAX_URL = 'https://api.minimaxi.com/anthropic';
const FAKE_API_KEY = 'sk-test-fake-key-for-reproduction';

function makeClient(): AnthropicClient {
  return new AnthropicClient({
    apiKey: FAKE_API_KEY,
    baseURL: MINIMAX_URL,
    model: 'MiniMax-M3',
    provider: 'anthropic',
  });
}

/**
 * Drain the async generator just enough to trigger the request.
 * Returns the body of the captured POST.
 */
async function captureRequestBody(
  client: AnthropicClient,
  messages: Message[]
): Promise<any> {
  let captured: any = null;
  // Spy on the SDK's stream method directly. The Anthropic SDK exposes
  // `client.messages.stream`; we replace it to capture the body it would
  // POST and emit a minimal valid stream response.
  const sdkClient = (client as any).client; // private Anthropic instance
  const streamSpy = vi
    .spyOn(sdkClient.messages, 'stream')
    .mockImplementation(async (params: any) => {
      captured = params;
      // Return a fake object that has the streaming methods the wrapper calls
      const handlers: any[] = [];
      return {
        on: (event: string, cb: any) => {
          handlers.push({ event, cb });
        },
        finalMessage: () =>
          Promise.resolve({
            id: 'm', type: 'message', role: 'assistant', model: 'MiniMax-M3',
            content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }),
        // Async iterator — yields nothing; just signals done
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ value: undefined, done: true }),
            return: async () => ({ value: undefined, done: true }),
          };
        },
      } as any;
    });

  try {
    const gen = client.streamChat(messages, {
      systemPrompt: 'You are a test assistant.',
      tools: [],
    });
    for await (const _evt of gen) {
      // drain
    }
  } catch {
    // Ignore stream-parse errors
  } finally {
    streamSpy.mockRestore();
  }
  return captured;
}

describe('Reproduction: Anthropic 2013 tool_use_id mismatch', () => {
  let client: AnthropicClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SCENARIO A — clean history: tool_use immediately followed by tool_result → passes', async () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run ls', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_clean_1', name: 'Bash', input: { cmd: 'ls' } }],
        timestamp: 2,
      },
      { id: 't1', role: 'tool', content: 'file.txt', tool_call_id: 'toolu_clean_1', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    console.log('SCENARIO A outgoing body:', JSON.stringify(body, null, 2));
    const flat = JSON.stringify(body.messages);
    expect(flat).toContain('toolu_clean_1');
  });

  it('SCENARIO B — tool_use → user message → tool_result (task-notification injection)', async () => {
    // The exact pattern that the explore agent flagged: a user message inserted
    // between the assistant tool_use and its tool_result.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run ls', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_split_1', name: 'Bash', input: { cmd: 'ls' } }],
        timestamp: 2,
      },
      // <-- task-notification user message inserted here, like DuyaAgent.ts:1033-1042
      {
        id: 'tn1',
        role: 'user',
        content: '<task-notification>sub-agent done</task-notification>',
        timestamp: 2.5,
        metadata: { isTaskNotification: true } as any,
      },
      { id: 't1', role: 'tool', content: 'file.txt', tool_call_id: 'toolu_split_1', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Continue', timestamp: 4 },
    ];

    const body = await captureRequestBody(client, messages);
    console.log('SCENARIO B outgoing body:', JSON.stringify(body, null, 2));

    // The bug: orphan detector strips tool_use but keeps tool_result.
    // Verify the outgoing body has tool_result with id "toolu_split_1"
    // but NO tool_use with id "toolu_split_1" precedes it → would trigger 2013.
    const msgList: any[] = body.messages;
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    let order: string[] = [];
    for (const m of msgList) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') {
            toolUseIds.add(b.id);
            order.push(`use:${b.id}`);
          }
        }
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            toolResultIds.add(b.tool_use_id);
            order.push(`result:${b.tool_use_id}`);
          }
        }
      }
    }
    console.log('SCENARIO B order:', order);
    console.log('SCENARIO B toolUseIds:', [...toolUseIds]);
    console.log('SCENARIO B toolResultIds:', [...toolResultIds]);

    // Diagnose: is there a result whose id is NOT in toolUseIds?
    const orphanResults = [...toolResultIds].filter((id) => !toolUseIds.has(id));
    if (orphanResults.length > 0) {
      console.log('!!! BUG REPRODUCED — orphan tool_results:', orphanResults);
    }
  });

  it('SCENARIO C — empty tool_use id (MiniMax M3 hypothetical) collapses to tool_0, two of them collide', async () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Do two things', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '', name: 'Bash', input: { cmd: 'a' } },
          { type: 'tool_use', id: '', name: 'Bash', input: { cmd: 'b' } },
        ],
        timestamp: 2,
      },
      { id: 't1', role: 'tool', content: 'a-out', tool_call_id: '', timestamp: 3 },
      { id: 't2', role: 'tool', content: 'b-out', tool_call_id: '', timestamp: 3.5 },
    ];

    const body = await captureRequestBody(client, messages);
    console.log('SCENARIO C outgoing body:', JSON.stringify(body, null, 2));

    // Find any duplicate tool_use_id or tool_use_id in the body
    const ids: string[] = [];
    for (const m of body.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') ids.push(`u:${b.id}`);
        }
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') ids.push(`r:${b.tool_use_id}`);
        }
      }
    }
    const counts: Record<string, number> = {};
    for (const id of ids) counts[id] = (counts[id] || 0) + 1;
    const dupes = Object.entries(counts).filter(([, n]) => n > 1);
    console.log('SCENARIO C duplicates:', dupes);
  });

  it('SCENARIO D — mixed: tool_use block in assistant content + task-notification user in middle', async () => {
    // Most realistic: assistant with mixed text+tool_use content (typical Claude
    // output), then a task-notification, then the tool_result.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Investigate', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_real_1', name: 'Bash', input: { cmd: 'ls' } },
        ],
        timestamp: 2,
      },
      {
        id: 'tn1',
        role: 'user',
        content: '<task-notification>research done</task-notification>',
        timestamp: 2.7,
        metadata: { isTaskNotification: true } as any,
      },
      { id: 't1', role: 'tool', content: 'out', tool_call_id: 'toolu_real_1', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    console.log('SCENARIO D outgoing body:', JSON.stringify(body, null, 2));

    // Quick adjacency check
    const seen: Array<{ kind: 'use' | 'result' | 'other'; id?: string; text?: string }> = [];
    for (const m of body.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') seen.push({ kind: 'use', id: b.id });
          else if (b.type === 'text') seen.push({ kind: 'other', text: b.text });
        }
      } else if (m.role === 'user') {
        if (typeof m.content === 'string') {
          seen.push({ kind: 'other', text: m.content });
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'tool_result') seen.push({ kind: 'result', id: b.tool_use_id });
            else if (b.type === 'text') seen.push({ kind: 'other', text: b.text });
          }
        }
      }
    }
    console.log('SCENARIO D flattened event order:', seen);

    // Anthropic rule: for every 'result' with id X, the immediately preceding
    // 'use' block (in the same assistant message) or the closest preceding
    // assistant message must contain a 'use' with id X. If not, 2013.
    for (let i = 0; i < seen.length; i++) {
      if (seen[i].kind !== 'result') continue;
      const targetId = seen[i].id;
      // Walk back: find most recent 'use' with this id; assert no other
      // message is between them that lacks the use.
      let foundUse = false;
      for (let j = i - 1; j >= 0; j--) {
        if (seen[j].kind === 'use' && seen[j].id === targetId) {
          foundUse = true;
          break;
        }
      }
      if (!foundUse) {
        console.log(`!!! BUG: result ${targetId} has no preceding use in outgoing body`);
      } else {
        console.log(`OK: result ${targetId} has a preceding use`);
      }
    }
  });
});
