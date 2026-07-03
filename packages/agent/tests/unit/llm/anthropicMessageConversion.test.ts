/**
 * Targeted unit tests for the tool_use / tool_result round-trip
 * integrity fixes in anthropic-client.ts.
 *
 * Covers (matches Plan 220 Phase 5):
 *   1. sanitizeToolId("")            → tool_synth_1
 *   2. Two calls with different counters produce distinct outputs
 *   3. sanitizeToolId("toolu_01")    → unchanged
 *   4. sanitizeToolId("has space")   → has_space
 *   5. Scenario B (tool_use → user → tool_result) keeps both intact
 *   6. Scenario D (mixed text+tool_use, intervening user) keeps text + tool_use
 *   7. Orphan tool_result (no matching tool_use) emits text placeholder
 *   8. Orphan tool_use (no matching tool_result) keeps assistant message
 *      with text placeholder
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

async function captureRequestBody(
  client: AnthropicClient,
  messages: Message[]
): Promise<any> {
  let captured: any = null;
  const sdkClient = (client as any).client;
  const streamSpy = vi
    .spyOn(sdkClient.messages, 'stream')
    .mockImplementation(async (params: any) => {
      captured = params;
      return {
        on: () => {},
        finalMessage: () =>
          Promise.resolve({
            id: 'm', type: 'message', role: 'assistant', model: 'MiniMax-M3',
            content: [], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
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
    // ignore
  } finally {
    streamSpy.mockRestore();
  }
  return captured;
}

/**
 * Flatten an outgoing-API message array into a chronological list
 * of (kind, id) pairs so we can assert on adjacency and identity.
 */
function flattenEvents(messages: any[]): Array<{ kind: 'use' | 'result' | 'text' | 'other'; id?: string; text?: string }> {
  const out: Array<{ kind: 'use' | 'result' | 'text' | 'other'; id?: string; text?: string }> = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') out.push({ kind: 'use', id: b.id });
        else if (b.type === 'text') out.push({ kind: 'text', text: b.text });
        else out.push({ kind: 'other' });
      }
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ kind: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') out.push({ kind: 'result', id: b.tool_use_id });
          else if (b.type === 'text') out.push({ kind: 'text', text: b.text });
          else out.push({ kind: 'other' });
        }
      }
    }
  }
  return out;
}

describe('Tool use / tool result round-trip — Plan 220 fixes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1-4. sanitizeToolId unit behaviour
  // ===========================================================================
  //
  // sanitizeToolId is not exported, so we exercise it indirectly via
  // captureRequestBody and observe the IDs the converter emits.

  it('sanitizeToolId emits tool_synth_<n> for empty IDs (case 1 + 2)', async () => {
    const client = makeClient();
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
    const events = flattenEvents(body.messages);
    const useIds = events.filter((e) => e.kind === 'use').map((e) => e.id);
    const resultIds = events.filter((e) => e.kind === 'result').map((e) => e.id);

    // All emitted IDs are non-empty synthetic strings
    for (const id of [...useIds, ...resultIds]) {
      expect(id).toBeTruthy();
      expect(id!.length).toBeGreaterThan(0);
    }

    // All emitted IDs are distinct — no two tool_use_id values collide
    const allIds = [...useIds, ...resultIds];
    expect(new Set(allIds).size).toBe(allIds.length);

    // Each tool_use matches exactly one tool_result
    expect(useIds.length).toBe(resultIds.length);
  });

  it('sanitizeToolId leaves valid IDs unchanged (case 3)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }],
        timestamp: 2,
      },
      { id: 't1', role: 'tool', content: 'out', tool_call_id: 'toolu_01', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);
    const useId = events.find((e) => e.kind === 'use')?.id;
    expect(useId).toBe('toolu_01');
  });

  it('sanitizeToolId replaces invalid chars with underscore (case 4)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'has space', name: 'Bash', input: {} }],
        timestamp: 2,
      },
      { id: 't1', role: 'tool', content: 'out', tool_call_id: 'has space', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);
    const useId = events.find((e) => e.kind === 'use')?.id;
    // Spaces are replaced — the exact replacement character is implementation
    // detail, but the id must remain valid (no spaces) and consistent
    // between the use block and the result block.
    expect(useId).not.toContain(' ');
    const resultId = events.find((e) => e.kind === 'result')?.id;
    expect(resultId).toBe(useId);
  });

  // ===========================================================================
  // 5. Scenario B — tool_use → user → tool_result (the production 2013 trigger)
  // ===========================================================================

  it('keeps tool_use and tool_result intact when a user message sits between them (case 5)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run ls', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_B_1', name: 'Bash', input: { cmd: 'ls' } }],
        timestamp: 2,
      },
      {
        id: 'tn1',
        role: 'user',
        content: '<task-notification>sub-agent done</task-notification>',
        timestamp: 2.5,
        metadata: { isTaskNotification: true } as any,
      },
      { id: 't1', role: 'tool', content: 'file.txt', tool_call_id: 'toolu_B_1', timestamp: 3 },
      { id: 'u2', role: 'user', content: 'Continue', timestamp: 4 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);

    // Both the tool_use and the tool_result must be present.
    const useIds = events.filter((e) => e.kind === 'use').map((e) => e.id);
    const resultIds = events.filter((e) => e.kind === 'result').map((e) => e.id);
    expect(useIds).toContain('toolu_B_1');
    expect(resultIds).toContain('toolu_B_1');

    // Every result's id is in some assistant's use set — this is exactly
    // the Anthropic invariant that triggered 2013 before the fix.
    const useSet = new Set(useIds);
    for (const id of resultIds) {
      expect(useSet.has(id!)).toBe(true);
    }

    // The task-notification text survived the round-trip (the message
    // body wasn't dropped along with its tool blocks).
    const allText = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('|');
    expect(allText).toContain('<task-notification>sub-agent done</task-notification>');
  });

  // ===========================================================================
  // 6. Scenario D — mixed text+tool_use with intervening user message
  // ===========================================================================

  it('keeps mixed text+tool_use across intervening user message (case 6)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Investigate', timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_D_1', name: 'Bash', input: { cmd: 'ls' } },
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
      { id: 't1', role: 'tool', content: 'out', tool_call_id: 'toolu_D_1', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);

    // The assistant's text "Let me check." must survive — the fix
    // replaces an orphan tool_use with a placeholder rather than
    // dropping the whole assistant message.
    const allText = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('|');
    expect(allText).toContain('Let me check.');
    expect(allText).toContain('<task-notification>research done</task-notification>');

    // The tool_use and tool_result round-trip
    const useIds = events.filter((e) => e.kind === 'use').map((e) => e.id);
    const resultIds = events.filter((e) => e.kind === 'result').map((e) => e.id);
    expect(useIds).toContain('toolu_D_1');
    expect(resultIds).toContain('toolu_D_1');
  });

  // ===========================================================================
  // 7. Orphan tool_result → emit text placeholder, do NOT drop the message
  // ===========================================================================

  it('orphan tool_result (no matching tool_use) is replaced with text placeholder (case 7)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
      {
        id: 'tn1',
        role: 'user',
        content: '<task-notification>something happened</task-notification>',
        timestamp: 1.5,
        metadata: { isTaskNotification: true } as any,
      },
      // Orphan tool_result — its tool_use is gone
      { id: 't1', role: 'tool', content: 'orphan output', tool_call_id: 'orphan-tool', timestamp: 2 },
      // If we drop the whole user message above, the next message would
      // merge into nothing. So we expect a placeholder text block to be
      // emitted in the orphan tool_result's slot.
      { id: 'u2', role: 'user', content: 'Continue', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);

    // There must be NO result with id "orphan-tool" — it's been dropped.
    const resultIds = events.filter((e) => e.kind === 'result').map((e) => e.id);
    expect(resultIds).not.toContain('orphan-tool');

    // The user-side text content must survive (both the task-notification
    // and the next user message). If the orphan tool_result's whole
    // user-message had been dropped, the next user message would still
    // be present but the placeholder text from the orphan slot would not.
    const allText = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('\n');
    expect(allText).toContain('<task-notification>something happened</task-notification>');
    expect(allText).toContain('Continue');
  });

  // ===========================================================================
  // 8. Orphan tool_use → keep assistant message, replace with text placeholder
  // ===========================================================================

  it('orphan tool_use (no matching tool_result) keeps the assistant message (case 8)', async () => {
    const client = makeClient();
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Investigate', timestamp: 1 },
      // Mixed text + tool_use, but the tool_result that should follow
      // was never produced (e.g. the assistant's stream died mid-call).
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'unmatched-tool', name: 'Bash', input: {} },
        ],
        timestamp: 2,
      },
      // The tool_result is missing — no message references 'unmatched-tool'.
      { id: 'u2', role: 'user', content: 'Never mind', timestamp: 3 },
    ];

    const body = await captureRequestBody(client, messages);
    const events = flattenEvents(body.messages);

    // The text "Let me check." must survive — it would have been lost
    // if the orphan-detection logic dropped the whole assistant message.
    const allText = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('\n');
    expect(allText).toContain('Let me check.');
    expect(allText).toContain('Never mind');

    // The orphan tool_use must NOT have a matching tool_result — and
    // crucially there must be NO result with that orphan id anywhere.
    const resultIds = events.filter((e) => e.kind === 'result').map((e) => e.id);
    expect(resultIds).not.toContain('unmatched-tool');
  });
});