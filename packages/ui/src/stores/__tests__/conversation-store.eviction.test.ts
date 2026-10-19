// Tests for the setActiveThread eviction decision (renderer memory hygiene).
//
// Regression target: the renderer retained every opened session's transcript
// in `messages` for its whole lifetime, so long dev sessions grew the main
// renderer process into the gigabytes. Transcripts are DB-backed, so sessions
// navigated away from are now dropped — except ones with a live stream,
// whose in-memory rows feed useStreamingActions' durable subtraction.

import { describe, expect, it } from 'vitest';
import { isThreadEvictable } from '../conversation-store';

const notBusy = () => false;
const busy = (id: string) => id === 'busy-session';

describe('isThreadEvictable', () => {
  it('evicts the previous session transcript on switch', () => {
    expect(isThreadEvictable('session-a', 'session-b', notBusy)).toBe(true);
  });

  it('never evicts when there is no previous session', () => {
    expect(isThreadEvictable(null, 'session-b', notBusy)).toBe(false);
  });

  it('never evicts the session being switched to', () => {
    expect(isThreadEvictable('session-a', 'session-a', notBusy)).toBe(false);
  });

  it('keeps the previous transcript while its stream is still live', () => {
    expect(isThreadEvictable('busy-session', 'session-b', busy)).toBe(false);
  });

  it('evicts once the previous session is no longer streaming', () => {
    expect(isThreadEvictable('session-a', 'session-b', busy)).toBe(true);
  });
});
