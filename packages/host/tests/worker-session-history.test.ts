/**
 * The Host's session-history compatibility surface.
 *
 * The behaviour of the restore moved to `@duya/agent-runtime/session` and is
 * tested there. What is tested HERE is the thing that is specific to the
 * Host: that the published subpath still reaches the implementation, and that
 * it reaches the SAME implementation rather than a second copy.
 *
 * The identity assertion is the load-bearing one. A forwarding layer that
 * re-wrapped the call would satisfy every behavioural test and still be a
 * second implementation — the kind that drifts silently, and the kind this
 * migration exists to remove.
 */

import { describe, expect, it } from 'vitest';
import { hydrateSessionHistory } from '@duya/agent-runtime/session';
import {
  hydrateWorkerSessionHistory,
  hydrateSessionHistory as hydrateSessionHistoryFromHost,
} from '../src/worker-session-history.js';

describe('the Host session history compatibility layer', () => {
  it('reaches the Runtime implementation', () => {
    expect(typeof hydrateWorkerSessionHistory).toBe('function');
    expect(typeof hydrateSessionHistoryFromHost).toBe('function');
  });

  it('is the same implementation, not a second copy', () => {
    expect(hydrateWorkerSessionHistory).toBe(hydrateSessionHistory);
    expect(hydrateSessionHistoryFromHost).toBe(hydrateSessionHistory);
  });
});
