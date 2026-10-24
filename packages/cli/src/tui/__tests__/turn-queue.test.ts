import { describe, expect, it } from 'vitest';
import { TurnQueue, type PendingDraft, type TurnOutcome } from '../turn-queue.js';

function harness() {
  const started: string[] = [];
  const drafts: PendingDraft[] = [];
  const releases: Array<(outcome: TurnOutcome) => void> = [];
  const errors: unknown[] = [];
  const queue = new TurnQueue({
    execute: (text, draft) => {
      started.push(text);
      drafts.push(draft);
      return new Promise<TurnOutcome>((resolve) => releases.push(resolve));
    },
    onChange: () => {},
    onError: (error) => errors.push(error),
  });
  return { queue, started, drafts, releases, errors };
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

describe('draft identity', () => {
  it('hands each draft to execute with its mode, mailbox row and echo flag', async () => {
    const h = harness();
    h.queue.submit('steer me', { mode: 'steer', mailboxId: 'row-1', echoed: true });
    expect(h.drafts[0]).toMatchObject({ text: 'steer me', mode: 'steer', mailboxId: 'row-1', echoed: true });
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });

  it('keeps draining after a draft was already delivered by the running turn', async () => {
    const h = harness();
    h.queue.submit('first');
    h.queue.submit('missed steer', { mode: 'steer', mailboxId: 'row-1' });
    h.queue.submit('queued next');
    h.releases.shift()!('completed');
    await Promise.resolve();
    // The steer was claimed by the turn that just ended: deliver nothing, and
    // do not let the skip count as an interruption.
    h.releases.shift()!('skipped');
    await Promise.resolve();
    expect(h.started).toEqual(['first', 'missed steer', 'queued next']);
    expect(h.queue.snapshot).toMatchObject({ busy: true, paused: false, pending: [] });
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
    expect(h.queue.snapshot).toEqual({ busy: false, paused: false, pending: [] });
  });

  it('reclassifies a queued draft in place so its place in line is kept', async () => {
    const h = harness();
    h.queue.submit('running');
    h.queue.submit('held');
    const held = h.queue.drafts[0]!;
    expect(h.queue.reclassify(held.key, { mode: 'steer', mailboxId: 'row-9', text: 'held (edited)', echoed: true }))
      .toMatchObject({ key: held.key, mode: 'steer', mailboxId: 'row-9', text: 'held (edited)', echoed: true });
    expect(h.queue.drafts).toHaveLength(1);
    expect(h.queue.reclassify('draft-missing', { text: 'nope' })).toBeNull();
    h.releases.shift()!('completed');
    await Promise.resolve();
    expect(h.started).toEqual(['running', 'held (edited)']);
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });

  it('puts an interrupted-and-sent draft ahead of older queued ones', async () => {
    const h = harness();
    h.queue.submit('running');
    h.queue.submit('older queued');
    h.queue.submit('esc draft', { front: true });
    expect(h.queue.snapshot.pending).toEqual(['esc draft', 'older queued']);
    h.releases.shift()!('completed');
    await Promise.resolve();
    expect(h.started).toEqual(['running', 'esc draft']);
    h.releases.shift()!('completed');
    await Promise.resolve();
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });

  it('returns the whole recalled draft so the caller can withdraw its mailbox row', async () => {
    const h = harness();
    h.queue.submit('running');
    h.queue.submit('steer', { mode: 'steer', mailboxId: 'row-3' });
    expect(h.queue.takeLastDraft()).toMatchObject({ text: 'steer', mailboxId: 'row-3' });
    expect(h.queue.takeLastDraft()).toBeNull();
    h.releases.shift()!('completed');
    await h.queue.whenIdle();
  });
});
