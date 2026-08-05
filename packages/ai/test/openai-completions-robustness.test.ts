import { describe, it, expect } from 'vitest';
import {
  repairToolPairing,
  synthesizeRuntimeToolId,
} from '../src/api/openai-completions.js';
import type { Message } from '../src/types.js';
import { withIdleTimeout } from '../src/utils/idle-timeout.js';

describe('synthesizeRuntimeToolId', () => {
  it('returns the id unchanged when it is already valid', () => {
    expect(synthesizeRuntimeToolId('call_abc123')).toBe('call_abc123');
    expect(synthesizeRuntimeToolId('toolu_01-XYZ_ab')).toBe('toolu_01-XYZ_ab');
  });

  it('sanitizes invalid characters instead of dropping them', () => {
    expect(synthesizeRuntimeToolId('call abc.def/gh')).toBe('call_abc_def_gh');
    expect(synthesizeRuntimeToolId('id@with#chars!')).toBe('id_with_chars_');
  });

  it('synthesizes a prefixed id for an empty string', () => {
    const id = synthesizeRuntimeToolId('');
    expect(id).toMatch(/^toolu_synth_[a-zA-Z0-9_]+$/);
    expect(id.length).toBeGreaterThan('toolu_synth_'.length);
  });

  it('synthesizes a prefixed id for undefined and null', () => {
    expect(synthesizeRuntimeToolId(undefined)).toMatch(/^toolu_synth_/);
    expect(synthesizeRuntimeToolId(null)).toMatch(/^toolu_synth_/);
  });

  it('replaces runs of invalid characters with underscores', () => {
    // Sanitize-first: an all-invalid id becomes underscores, which is a
    // valid non-empty id, so no synthesis is needed.
    expect(synthesizeRuntimeToolId('...')).toBe('___');
    expect(synthesizeRuntimeToolId('@#$')).toBe('___');
  });

  it('produces unique ids across calls', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => synthesizeRuntimeToolId('')),
    );
    expect(ids.size).toBe(100);
  });
});

describe('withIdleTimeout', () => {
  it('passes through all values from a healthy stream', async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const values: number[] = [];
    for await (const v of withIdleTimeout(source(), 1000)) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it('throws TimeoutError when the stream stalls', async () => {
    // Manual iterator: next() never resolves (hung upstream connection),
    // return() resolves immediately so cleanup completes. An async
    // generator stuck in a pending await cannot be used here because its
    // return() request queues behind the pending next() forever.
    let cleanedUp = false;
    const stalled: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: async () => {
            cleanedUp = true;
            return { done: true, value: undefined };
          },
        };
      },
    };

    const iterate = async () => {
      for await (const _ of withIdleTimeout(stalled, 50)) {
        // consume
      }
    };

    await expect(iterate()).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('Stream idle timeout'),
    });
    expect(cleanedUp).toBe(true);
  });

  it('resets the timer after each received chunk', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function* slowButAlive() {
      yield 'a';
      await delay(80); // under the 150ms budget
      yield 'b';
      await delay(80);
      yield 'c';
    }

    const values: string[] = [];
    for await (const v of withIdleTimeout(slowButAlive(), 150)) {
      values.push(v);
    }
    expect(values).toEqual(['a', 'b', 'c']);
  });
});

describe('repairToolPairing', () => {
  it('drops orphan tool_use blocks whose result is missing', () => {
    const input: Message[] = [
      { role: 'user', content: 'Run tools' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will.' },
          { type: 'tool_use', id: 'call_00_A', name: 'bash', input: { command: 'a' } },
        ],
      },
    ];
    const out = repairToolPairing(input);
    const assistant = out[1];
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    expect(content.some((b) => b.type === 'tool_use')).toBe(false);
    // The assistant turn is kept non-empty with a text fallback.
    expect(content.some((b) => b.type === 'text')).toBe(true);
  });

  it('keeps intact tool_use/tool_result pairs unchanged', () => {
    const input: Message[] = [
      { role: 'user', content: 'Run it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_00_A', name: 'bash', input: { command: 'a' } }],
      },
      { role: 'tool', tool_call_id: 'call_00_A', content: 'ok' },
    ];
    const out = repairToolPairing(input);
    expect(out).toHaveLength(3);
  });

  it('drops orphan tool_result messages without a matching tool_use', () => {
    const input: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'tool', tool_call_id: 'call_missing', content: 'stale result' },
    ];
    const out = repairToolPairing(input);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out).toHaveLength(2);
  });

  it('keeps only the tool_use blocks that have a result when some results are missing', () => {
    const input: Message[] = [
      { role: 'user', content: 'do stuff' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_00_A', name: 'bash', input: { command: 'a' } },
          { type: 'tool_use', id: 'call_01_B', name: 'bash', input: { command: 'b' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_00_A', content: 'result-a' },
    ];
    const out = repairToolPairing(input);
    const assistant = out[1];
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    const kept = content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    expect(kept).toEqual(['call_00_A']);
  });

  it('reproduces and repairs the reported 400 shape (assistant tool_use without result)', () => {
    // Mirrors the user-reported error: "messages.1.3: tool_use ids were found
    // without tool_result blocks immediately after: call_00_..., call_01_..."
    const input: Message[] = [
      { role: 'user', content: 'Run tools' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run the tools.' },
          { type: 'tool_use', id: 'call_00_Tp5nrJfZvUk2duytm9xM4482', name: 'bash', input: { command: 'a' } },
          { type: 'tool_use', id: 'call_01_V3LR6pZYfPEc8hsY4eyi8351', name: 'bash', input: { command: 'b' } },
        ],
      },
    ];
    const tinyOut = repairToolPairing(input);
    const assistant = tinyOut[1];
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    expect(content.some((b) => b.type === 'tool_use')).toBe(false);
    // No dangling tool messages remain.
    expect(tinyOut.some((m) => m.role === 'tool')).toBe(false);
  });
});
