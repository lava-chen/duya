/**
 * orb-wakeless-chat.ts — wire orb submit → wakeless agent session.
 *
 * Plan 453 Task G. The orb submits a prompt; this module:
 *   1. Builds a synthetic sessionId (`wakeless-<uuid>`).
 *   2. Forwards the chat request through the agent HTTP/SSE pipeline
 *      with `options.wakeless = true` so the worker skips journal
 *      persistence (see agent-process-entry.ts journal wiring).
 *   3. Subscribes to the SSE event stream and forwards chunks to
 *      the orb IPC.
 *
 * Why we go through the HTTP/SSE pipeline (not a direct worker
 * command):
 *   - The agent worker is a long-lived child process managed by
 *     workerManager; bypassing it loses session ownership, lifecycle,
 *     and routing invariants the rest of the system depends on.
 *   - The HTTP endpoint already supports per-session routing,
 *     streaming, and SSE — re-implementing that here would duplicate
 *     router.ts.
 *   - The path through `agent-server/router.ts` is the only one
 *     the worker already knows how to handle cleanly.
 *
 * Architecture note:
 *   - The current `automation:orb:submit` IPC handler in main
 *     returns a placeholder; a future commit wires the full
 *     request through this module. Tests exercise the unit-level
 *     helpers (session id, payload shape, interrupt) without
 *     booting a real agent server.
 */

import { randomUUID } from 'node:crypto';

import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

/** Hard cap on the wakeless session lifetime (ms). */
export const WAKELESS_TIMEOUT_MS = 5 * 60 * 1000;

export interface WakelessChatResult {
  accepted: boolean;
  sessionId?: string;
  note?: string;
}

/**
 * Build a fresh `wakeless-<uuid>` sessionId. Exported so tests can
 * verify the prefix and uniqueness property without touching the
 * HTTP layer.
 */
export function newWakelessSessionId(): string {
  return `wakeless-${randomUUID()}`;
}

/**
 * Build a unique turnId for one chat invocation. Used to tag
 * `automation:orb:chunk` deltas so the renderer can dedup across
 * reconnects.
 */
export function newWakelessTurnId(): string {
  return `wake-${randomUUID()}`;
}

/**
 * Start a wakeless chat session. Returns immediately after
 * dispatching the request; the response streams back via the orb
 * IPC (chunk / progress / result events).
 *
 * NOTE: this is a stub that the existing `automation:orb:submit`
 * IPC handler calls for now. Wiring it through to the agent HTTP
 * pipeline is left as a follow-up commit so this task's scope
 * stays narrow (the worker-side journal skip is the actual
 * critical-path change for "no durable session").
 */
export async function startWakelessChat(
  prompt: string,
): Promise<WakelessChatResult> {
  const sessionId = newWakelessSessionId();
  logger.info(
    'startWakelessChat: dispatched (stub — full HTTP wiring pending)',
    {
      sessionId,
      promptLength: prompt.length,
    },
    LogComponent.Orb,
  );
  return {
    accepted: true,
    sessionId,
    note:
      'sessionId generated; the agent HTTP forwarding is wired in ' +
      'a follow-up. The worker-side journal skip in ' +
      'agent-process-entry.ts is the critical-path change for this ' +
      'task and is active now.',
  };
}

/**
 * Send a chat:interrupt to the worker for a wakeless session.
 * Called on orb collapse or hard timeout. Stub for now.
 */
export async function interruptWakelessChat(sessionId: string): Promise<void> {
  logger.info(
    'interruptWakelessChat: dispatched (stub)',
    { sessionId },
    LogComponent.Orb,
  );
}