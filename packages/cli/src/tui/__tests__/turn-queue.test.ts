import { describe, expect, it } from 'vitest';
import { TurnQueue, type TurnOutcome } from '../turn-queue.js';

function harness() {
  const started: string[] = [];
  const releases: Array<(outcome: TurnOutcome) => void> = [];
  const errors: unknown[] = [];
  const queue = new TurnQueue({
    execute: (text) => {
      started.push(text);
      return new Promise<TurnOutcome>((resolve) => releases.push(resolve));
    },
    onChange: () => {},
    onError: (error) => errors.push(error),
  });
  return { queue, started, releases, errors };
}

describe('local turn admission', () => {
  it('accepts a fresh intent after cancellation when no older drafts remain', async () => {
    const h = harness();
    h.queue.submit('first');
    h.releases.shift()!('cancelled');
    await h.queue.whenIdle();
    h.queue.submit('correction');
    expect(h.started).toEqual(['first', 'correction']);
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });
  it('locks before startup yields and drains one FIFO draft at a time', async () => {
    const h = harness();
    h.queue.submit('first');
    h.queue.submit('second');
    h.queue.submit('third');
    expect(h.started).toEqual(['first']);
    expect(h.queue.snapshot.pending).toEqual(['second', 'third']);
    h.releases.shift()!('completed');
    await Promise.resolve();
    expect(h.started).toEqual(['first', 'second']);
    h.releases.shift()!('completed');
    await Promise.resolve();
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
    expect(h.started).toEqual(['first', 'second', 'third']);
    expect(h.queue.snapshot.busy).toBe(false);
  });

  it.each(['cancelled', 'failed'] as const)('pauses pending drafts after %s', async (outcome) => {
    const h = harness();
    h.queue.submit('first');
    h.queue.submit('second');
    h.releases.shift()!(outcome);
    await h.queue.whenIdle();
    expect(h.started).toEqual(['first']);
    expect(h.queue.snapshot.paused).toBe(true);
    h.queue.resume();
    expect(h.started).toEqual(['first', 'second']);
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });

  it('keeps interruption pending even if the active API reports success', async () => {
    const h = harness();
    h.queue.submit('first');
    h.queue.submit('second');
    h.queue.pause();
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
    expect(h.started).toEqual(['first']);
    expect(h.queue.takeLast()).toBe('second');
    expect(h.queue.snapshot.pending).toEqual([]);
  });

  it('does not accept or start anything after close', async () => {
    const h = harness();
    h.queue.submit('first');
    h.queue.submit('second');
    h.queue.close();
    h.queue.submit('third');
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
    expect(h.started).toEqual(['first']);
    expect(h.queue.snapshot.pending).toEqual([]);
  });

  it('reports unexpected failures and preserves pending drafts', async () => {
    const error = new Error('disconnected');
    const queue = new TurnQueue({
      execute: async () => { throw error; },
      onChange: () => {},
      onError: (actual) => expect(actual).toBe(error),
    });
    queue.submit('first');
    queue.submit('second');
    await queue.whenIdle();
    expect(queue.snapshot).toEqual({ busy: false, paused: true, pending: ['second'] });
  });
});
