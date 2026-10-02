/**
 * The router-side contract of Plan 586: the run layer is a TEE, never a
 * replacement.
 *
 * ## What is being proven
 *
 * The headline claim of the Reference Run is that the UI does not change. That
 * is not a promise about the future — it is a statement about bytes on a wire
 * the renderer already parses today, so the only way to make it true is to
 * assert, mechanically, that what the router writes to SSE after Plan 586 is
 * exactly what it wrote before.
 *
 * Two separate invariants carry that claim, and they are asserted separately
 * because they fail for different reasons:
 *
 *  1. **Wire equality.** The serialised SSE frame is byte-identical whether or
 *     not the run layer is wired. This is the claim the renderer actually
 *     depends on.
 *  2. **Single-source identity.** The tee hands ONE object to both consumers —
 *     the run layer and the SSE writer. Identity (`toBe`), not deep equality:
 *     a tee that quietly rebuilt a copy for one of them could drop a field
 *     while still passing every structural comparison. A run that records a
 *     different frame than the user saw would be a lie with extra storage.
 *
 * The third thing proven here is containment: the run layer cannot break the
 * chat path. A run layer that can take down the user's message when its own
 * bookkeeping fails is not additive, it is a regression with extra steps.
 */

import { describe, it, expect, vi } from 'vitest';
import { normalizeAndObserve, normalizeWorkerEvent, type RouterDeps } from '../agents/server/router';

/** A deps object carrying only what the tee reads. */
const depsWith = (observe: unknown): Pick<RouterDeps, 'runOrchestrator'> =>
  ({ runOrchestrator: { observe } }) as unknown as RouterDeps;

/** A worker frame the way the worker actually emits it. */
const workerText = (content: string): Record<string, unknown> => ({ type: 'chat:text', data: content });

/** What the renderer actually parses off the SSE stream. */
const serialize = (f: Record<string, unknown> | null): string =>
  f === null ? '' : `event: ${String(f.type)}\ndata: ${JSON.stringify(f)}\n\n`;

const noopObserve = (): { legacy: null; forwardOnly: false } => ({ legacy: null, forwardOnly: false });

describe('the router tee: the SSE frame is the pre-586 frame', () => {
  it('serialises byte-identically with and without the run layer', () => {
    const raw = workerText('hello');

    const withoutRun = serialize(normalizeAndObserve('s1', raw, {}));
    const withRun = serialize(normalizeAndObserve('s1', raw, depsWith(noopObserve)));

    expect(withRun).toBe(withoutRun);
    // ...and both are what the pre-586 path produced.
    expect(withRun).toBe(serialize(normalizeWorkerEvent(raw)));
  });

  it('hands ONE object to both consumers', () => {
    const observe = vi.fn(noopObserve);
    const raw = workerText('hello');

    const written = normalizeAndObserve('s1', raw, depsWith(observe));

    const [, observed] = observe.mock.calls[0] as [string, Record<string, unknown>];
    // The same reference, not an equal one. If the tee cloned for either
    // consumer, the two could drift and the durable log would stop being a
    // record of what the user actually saw.
    expect(observed).toBe(written);
  });

  it('normalises before observing, and never hands back the raw frame', () => {
    const observe = vi.fn(noopObserve);
    const raw = workerText('hello');

    const written = normalizeAndObserve('s1', raw, depsWith(observe));

    const [, observed] = observe.mock.calls[0] as [string, Record<string, unknown>];
    expect(observed).not.toBe(raw);
    // `chat:text` is reshaped because the renderer reads `data.content`;
    // observing the raw frame would record a shape neither the UI nor the
    // translator ever sees.
    expect(written).toStrictEqual({ type: 'text', data: { content: 'hello' } });
  });

  it('is inert when no orchestrator is wired', () => {
    // `RouterDeps.runOrchestrator?` is optional on purpose: any embedder that
    // never installs the run layer must behave exactly as it did before.
    const raw = workerText('hi');
    expect(normalizeAndObserve('s1', raw, {})).toStrictEqual(normalizeWorkerEvent(raw));
  });
});

describe('the router tee: what the run layer receives', () => {
  it('observes under the session that opened the run', () => {
    const observe = vi.fn(noopObserve);
    normalizeAndObserve('session-42', workerText('hello'), depsWith(observe));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBe('session-42');
  });

  it('never observes control-plane events that must not reach SSE', () => {
    const observe = vi.fn(noopObserve);
    // `pong` and `memory:wakeup` are dropped by the normaliser. Observing them
    // would put a heartbeat and a memory-sweep trigger into a durable run log.
    for (const type of ['pong', 'memory:wakeup']) {
      expect(normalizeAndObserve('s1', { type }, depsWith(observe))).toBeNull();
    }
    expect(observe).not.toHaveBeenCalled();
  });
});

describe('the router tee: the run layer cannot break the chat path', () => {
  it('still returns the frame when the run layer throws', () => {
    const raw = workerText('hello');
    const observe = vi.fn(() => {
      throw new Error('control plane is down');
    });

    const written = normalizeAndObserve('s1', raw, depsWith(observe));

    expect(observe).toHaveBeenCalledTimes(1);
    expect(written).toStrictEqual(normalizeWorkerEvent(raw));
  });

  it('does not let a non-Error throw escape either', () => {
    const raw = workerText('hello');
    const observe = vi.fn(() => {
      throw 'a string, because nothing stops a bad dependency';
    });

    expect(normalizeAndObserve('s1', raw, depsWith(observe))).toStrictEqual(normalizeWorkerEvent(raw));
  });
});
