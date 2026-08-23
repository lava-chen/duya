import { describe, it, expect } from 'vitest';
import {
  shouldReplayStreamAfterError,
  streamReplayDelayMs,
  STREAM_REPLAY_MAX_ATTEMPTS,
} from '../stream-retry.js';

const baseCtx = {
  aborted: false,
  turnCommitted: false,
  attemptsUsed: 0,
};

describe('shouldReplayStreamAfterError (Plan 439)', () => {
  it('replays retryable transport deaths before the turn is committed', () => {
    // undici premature body close — the exact signature from the
    // OpenRouter mid-stream drop reports.
    const terminated = new TypeError('terminated');
    expect(shouldReplayStreamAfterError(terminated, baseCtx)).toBe(true);
  });

  it('does not replay once the attempt committed the assistant message', () => {
    // Post-`done` failures already wrote to the timeline; a replay would
    // duplicate the assistant message and tool results.
    const err = Object.assign(new Error('boom'), { status: 502 });
    expect(
      shouldReplayStreamAfterError(err, { ...baseCtx, turnCommitted: true }),
    ).toBe(false);
  });

  it('never replays after an abort', () => {
    const err = new Error('Request was aborted.');
    (err as { name: string }).name = 'AbortError';
    expect(shouldReplayStreamAfterError(err, { ...baseCtx, aborted: true })).toBe(false);
    expect(shouldReplayStreamAfterError(err, baseCtx)).toBe(false);
  });

  it('stops at the replay budget', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    for (let used = 0; used < STREAM_REPLAY_MAX_ATTEMPTS; used++) {
      expect(
        shouldReplayStreamAfterError(err, { ...baseCtx, attemptsUsed: used }),
      ).toBe(true);
    }
    expect(
      shouldReplayStreamAfterError(err, {
        ...baseCtx,
        attemptsUsed: STREAM_REPLAY_MAX_ATTEMPTS,
      }),
    ).toBe(false);
  });

  it('does not replay non-retryable errors (quota, auth, safety)', () => {
    const quota = new Error('insufficient_quota');
    const auth = Object.assign(new Error('invalid api key'), { status: 401 });
    const context = new Error('context_length_exceeded');
    for (const err of [quota, auth, context]) {
      expect(shouldReplayStreamAfterError(err, baseCtx)).toBe(false);
    }
  });
});

describe('streamReplayDelayMs', () => {
  it('doubles from 1s and caps at 8s', () => {
    expect(streamReplayDelayMs(1)).toBe(1000);
    expect(streamReplayDelayMs(2)).toBe(2000);
    expect(streamReplayDelayMs(3)).toBe(4000);
    expect(streamReplayDelayMs(4)).toBe(8000);
    expect(streamReplayDelayMs(50)).toBe(8000);
  });

  it('clamps non-positive attempts to the first step', () => {
    expect(streamReplayDelayMs(0)).toBe(1000);
    expect(streamReplayDelayMs(-3)).toBe(1000);
  });
});
