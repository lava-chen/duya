// Plan 571: the cross-turn sub-agent progress buffer.
//
// The bug this guards: a background sub-agent outlives the parent turn that
// spawned it, and `SessionState.agentProgressEvents` is reset on every run
// start and dropped by the terminal slim. Before the durable buffer, a running
// sub-agent's entire event history disappeared from the renderer mid-flight.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamSessionManager, type AgentProgressEvent } from '../stream-session-manager';

/** Reach the private ingest method — the buffer has no public "push" API by design. */
type BufferIngest = (event: AgentProgressEvent) => void;

function ingest(manager: StreamSessionManager): BufferIngest {
  return (manager as unknown as { recordSubagentProgress: BufferIngest }).recordSubagentProgress
    .bind(manager);
}

function ev(
  type: AgentProgressEvent['type'],
  childSessionId: string,
  extra: Partial<AgentProgressEvent> = {},
): AgentProgressEvent {
  return { type, sessionId: childSessionId, data: '', ...extra };
}

describe('StreamSessionManager sub-agent progress buffer', () => {
  let manager: StreamSessionManager;

  beforeEach(() => {
    manager = new StreamSessionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty log for an unknown sub-agent instead of throwing', () => {
    expect(manager.getSubagentProgressSnapshot('never-seen')).toEqual({
      events: [],
      startedAt: null,
      terminalAt: null,
    });
  });

  it('replays retained history to a late subscriber, then streams live', () => {
    const push = ingest(manager);
    push(ev('started', 'child-1'));
    push(ev('text', 'child-1', { data: 'hel' }));

    const seen: AgentProgressEvent[] = [];
    const unsubscribe = manager.subscribeToSubagentProgress('child-1', (e) => seen.push(e));

    // The panel opened mid-run must render what it missed, not start blank.
    expect(seen.map((e) => e.type)).toEqual(['started', 'text']);
    expect(seen[1].data).toBe('hel');

    push(ev('text', 'child-1', { data: 'lo' }));
    expect(seen.map((e) => e.data)).toEqual(['', 'hel', 'lo']);

    unsubscribe();
    push(ev('done', 'child-1'));
    expect(seen).toHaveLength(3);
  });

  it('keeps concurrent sub-agents in separate buckets', () => {
    const push = ingest(manager);
    push(ev('started', 'child-a'));
    push(ev('started', 'child-b'));
    push(ev('text', 'child-b', { data: 'b-only' }));

    expect(manager.getSubagentProgressSnapshot('child-a').events.map((e) => e.data)).toEqual(['']);
    expect(manager.getSubagentProgressSnapshot('child-b').events.map((e) => e.data)).toEqual(['', 'b-only']);
  });

  it('ignores events with no child session id rather than guessing a bucket', () => {
    // Every event on the agent_progress channel is a sub-agent event, and
    // `agentSessionId` is the only thing identifying which child it belongs to.
    // Filing an unidentified event into a guessed bucket would corrupt another
    // child's transcript.
    const push = ingest(manager);
    push({ type: 'text', data: 'orphan' });

    const seen: AgentProgressEvent[] = [];
    manager.subscribeToSubagentProgress('child-a', (e) => seen.push(e));
    expect(seen).toHaveLength(0);
  });

  it('stamps startedAt once and terminalAt on the first terminal event', () => {
    const push = ingest(manager);
    push(ev('started', 'child-1'));
    const afterStart = manager.getSubagentProgressSnapshot('child-1');
    expect(afterStart.startedAt).not.toBeNull();
    expect(afterStart.terminalAt).toBeNull();

    push(ev('done', 'child-1'));
    const afterDone = manager.getSubagentProgressSnapshot('child-1');
    expect(afterDone.startedAt).toBe(afterStart.startedAt);
    expect(afterDone.terminalAt).not.toBeNull();
  });

  it('does not reset startedAt on a repeated started event', () => {
    const push = ingest(manager);
    push(ev('started', 'child-1'));
    const first = manager.getSubagentProgressSnapshot('child-1').startedAt;
    push(ev('started', 'child-1'));
    expect(manager.getSubagentProgressSnapshot('child-1').startedAt).toBe(first);
  });

  it('retains a terminal buffer while a listener is attached', () => {
    // The panel renders from this log even long after completion, so a
    // mounted subscriber pins the entry regardless of the retention window.
    const push = ingest(manager);
    const unsubscribe = manager.subscribeToSubagentProgress('child-1', () => {});
    push(ev('started', 'child-1'));
    push(ev('done', 'child-1'));

    vi.useFakeTimers();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(manager.getSubagentProgressSnapshot('child-1').events).toHaveLength(2);

    unsubscribe();
    // Unsubscribing triggers eviction; the entry is now past retention.
    expect(manager.getSubagentProgressSnapshot('child-1').events).toHaveLength(0);
  });

  it('survives a listener that throws', () => {
    const push = ingest(manager);
    const good = vi.fn();
    manager.subscribeToSubagentProgress('child-1', () => {
      throw new Error('bad subscriber');
    });
    manager.subscribeToSubagentProgress('child-1', good);

    push(ev('started', 'child-1'));
    // The healthy subscriber must still receive the event.
    expect(good).toHaveBeenCalledTimes(1);
  });
});
