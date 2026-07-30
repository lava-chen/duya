import { describe, it, expect } from 'vitest';
import { synthesizeRuntimeToolId } from '../src/api/openai-completions.js';
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
