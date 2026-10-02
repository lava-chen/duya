// src/hooks/useSubagentRuntimeStream.ts
// Plan 571 Phase 2 — the live runtime view of ONE sub-agent run.
//
// Subscribes to the stream manager's cross-turn sub-agent buffer (keyed by the
// CHILD session id) instead of the parent turn's `agentProgressEvents`, which
// is wiped at every turn boundary and would leave a long-running background
// sub-agent spinning forever in its row. The buffer replays retained history
// synchronously on subscribe, so opening the panel mid-run renders the
// transcript it missed rather than starting blank.
//
// All transcript work is delegated to the pure projector in
// `@/lib/subagent-live-transcript`; this module only owns the subscription
// lifecycle and the elapsed clock.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { streamSessionManager, type AgentProgressEvent } from '@/lib/stream-session-manager';
import {
  projectSubagentLiveTranscript,
  type SubagentToolUseCounts,
} from '@/lib/subagent-live-transcript';
import { isTerminalSubagentStatus, type SubagentRunStatus } from '@/lib/subagent-status';

/** Elapsed-time refresh cadence while a run is in flight. */
const TICK_INTERVAL_MS = 500;

export interface SubagentRuntimeStream {
  status: SubagentRunStatus;
  startedAt: number | null;
  terminalAt: number | null;
  /** Wall-clock duration: frozen once terminal, ticking while running. */
  durationMs: number | null;
  toolCounts: SubagentToolUseCounts;
  /** Live transcript tail for this run (empty when nothing has arrived). */
  liveMessages: ReturnType<typeof projectSubagentLiveTranscript>['messages'];
  lastActivityAt: number | null;
  isStreaming: boolean;
  /** Terminal `error` / killed payload, for the header's detail line. */
  terminalText: string | null;
  /** True when the subscription is attached to a real child session. */
  hasLiveStream: boolean;
  /**
   * True once at least one event has been observed for this child. False means
   * "this session has no sub-agent run behind it" (a workflow node session, or
   * a history row recorded before the buffer existed) and is what the panel
   * uses to hide the runtime chrome instead of claiming `pending` forever.
   */
  hasRuntimeData: boolean;
}

const EMPTY_COUNTS: SubagentToolUseCounts = {
  read: 0,
  edit: 0,
  search: 0,
  shell: 0,
  browser: 0,
  other: 0,
  total: 0,
};

export function useSubagentRuntimeStream(params: { subAgentSessionId: string }): SubagentRuntimeStream {
  const subAgentSessionId = params.subAgentSessionId;
  const [events, setEvents] = useState<AgentProgressEvent[]>([]);
  const [timing, setTiming] = useState<{ startedAt: number | null; terminalAt: number | null }>({
    startedAt: null,
    terminalAt: null,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!subAgentSessionId) {
      setEvents([]);
      setTiming({ startedAt: null, terminalAt: null });
      return undefined;
    }

    setEvents([]);
    // The manager's own stamps are authoritative for the elapsed timer; the
    // projector derives the same values from the events themselves and is only
    // used as the fallback for logs recorded without `receivedAt`.
    const snapshot = streamSessionManager.getSubagentProgressSnapshot(subAgentSessionId);
    setTiming({ startedAt: snapshot.startedAt, terminalAt: snapshot.terminalAt });

    const unsubscribe = streamSessionManager.subscribeToSubagentProgress(
      subAgentSessionId,
      (event: AgentProgressEvent) => {
        setEvents((prev) => [...prev, event]);
        setTiming((prev) => ({
          startedAt: event.type === 'started' && prev.startedAt === null
            ? (event.receivedAt ?? Date.now())
            : prev.startedAt,
          terminalAt: event.type === 'done' || event.type === 'error'
            ? (event.receivedAt ?? Date.now())
            : prev.terminalAt,
        }));
      },
    );
    return unsubscribe;
  }, [subAgentSessionId]);

  const transcript = useMemo(() => projectSubagentLiveTranscript(events), [events]);

  const status = transcript.status;
  // Only a run that has actually reported something is "streaming". A
  // subscribed-but-silent child is `pending`: passing `isStreaming` for it
  // would hand MessageList a live presentation for an empty transcript.
  const isStreaming = status === 'running';

  // Tick only while live, so a finished sub-agent's timer stops burning
  // renders for the rest of the panel's life.
  useEffect(() => {
    if (isTerminalSubagentStatus(status)) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status]);

  const startedAt = transcript.startedAt ?? timing.startedAt;
  const terminalAt = transcript.terminalAt ?? timing.terminalAt;
  const durationMs = startedAt === null
    ? null
    : (terminalAt ?? now) - startedAt;

  return {
    status,
    startedAt,
    terminalAt,
    durationMs,
    toolCounts: events.length > 0 ? transcript.toolCounts : EMPTY_COUNTS,
    liveMessages: transcript.messages,
    lastActivityAt: transcript.lastActivityAt,
    isStreaming,
    terminalText: transcript.terminalText,
    hasLiveStream: subAgentSessionId.trim().length > 0,
    hasRuntimeData: events.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Stop control
// ---------------------------------------------------------------------------

export interface SubagentKillOutcome {
  ok: boolean;
  /** Human-readable reason, already phrased as non-fatal. */
  reason?: string;
}

// Mirrors `agent-sse-client.getPort`, which is module-private. Cached because
// the port cannot change while the agent server is up.
let cachedAgentServerPort: number | null = null;

async function resolveAgentServerPort(): Promise<number> {
  if (cachedAgentServerPort !== null) return cachedAgentServerPort;
  const api = window.electronAPI;
  if (!api?.getAgentServerPort) throw new Error('Agent server port API not available');
  const port = await api.getAgentServerPort();
  if (port === null) throw new Error('Agent server not running');
  cachedAgentServerPort = port;
  return port;
}

/**
 * Ask the agent server to stop one sub-agent of `parentSessionId`.
 *
 * Failure is NOT an error worth interrupting the user for: the run may have
 * finished between the click and the request, and the terminal event on the
 * progress channel is the authoritative signal. This resolves with
 * `{ ok: false, reason }` instead of throwing so the panel can keep rendering.
 */
export async function killSubagent(
  parentSessionId: string,
  taskId: string,
): Promise<SubagentKillOutcome> {
  const parent = parentSessionId.trim();
  const task = taskId.trim();
  if (!parent || !task) return { ok: false, reason: 'missing-ids' };

  try {
    const port = await resolveAgentServerPort();
    const response = await fetch(
      `http://127.0.0.1:${port}/sessions/${encodeURIComponent(parent)}/subagents/kill`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task }),
      },
    );
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'request-failed' };
  }
}
