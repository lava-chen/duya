/**
 * wake-dispatcher.ts — authoritative per-session wake queue + dispatch loop
 * (Plan 476 Phase 2.1).
 *
 * Phase 0 wired a *single-shot* idle wake: one background notification in →
 * one immediate run. Phase 2.1 replaces that with a real queue: every wake
 * (task.completion today; automation / DM / inbound in later phases) is
 * enqueued into the per-session queue from `packages/agent/src/wake` (pure,
 * immutable, lane-ordered, dedupes by item id), and a dispatch loop drains
 * it strictly one run at a time.
 *
 * Why this lives in main (476 §6.1): every run is launched by POSTing to the
 * agent-server HTTP endpoint, and only main-side code owns that path plus the
 * busy/idle truth (`session_runtime_locks`). The pure queue primitives stay
 * in packages/agent so both worker and main can import them and so the
 * sorting/merge semantics are unit-testable without Electron.
 *
 * Serialisation model:
 *  - `kick(sessionId)` starts a drain pass only when the session is NOT busy
 *    (`isLocked` false) and no drain is already running for it.
 *  - A drain pass runs items head-of-queue until the queue is empty or the
 *    session becomes busy mid-pass (a user turn pre-empts by locking).
 *  - When a drain backs off because the session is busy, it parks the
 *    remaining queue. The main process re-kicks on the next `lock:release`
 *    (db-bridge calls `notifySessionIdle`) — that is the "run ended" signal.
 *
 * Dedupe: two layers. (1) the pure queue merges by item.id, so re-notifying
 * the same taskId while it is still queued collapses to one item; (2) an
 * in-memory "recently dispatched" window prevents a duplicate notification
 * for an already-*run* task from waking the session again within 60s
 * (carried over from Phase 0-D; Phase 3 replaces this with pending_wakes).
 *
 * This module is deliberately dependency-injected (same seam as
 * idle-dispatcher) so the drain logic is fully unit-testable.
 */

import {
  createWakeQueue,
  enqueueWake,
  peekNextWake,
  dequeueNextWake,
  removeWakeWhere,
  type WakeQueue,
} from '../../packages/agent/src/wake/queue'
import type { WakeItem } from '../../packages/agent/src/wake/types'
import { createTurnEpochState } from '../../packages/agent/src/wake/epoch'
import { decidePreemption, asRedriven, type RunOrigin } from '../../packages/agent/src/wake/preemption'
import { buildAgentInboundWakePrompt } from '../../packages/agent/src/agent/dm/index.js'
import { getCoreStores } from '../db/core-connection'
import { runWakePromptInExistingSession, type WakeRunOptions, type WakeRunOutcome } from './wake-run'
import { maybeAutoReturnDmResult, runUsedSendToAgent } from './agent-dm-return'
import { reviveForInbound } from './channels'
import { parseAgentIdFromBotSession } from './bot-session-id'
import { interruptCronSession } from '../automation/agent-run'
import { getLogger, LogComponent } from '../logging/logger'

export interface WakeDispatcherDeps {
  /** Busy/idle truth for a session (session_runtime_locks mirror). */
  isLocked(sessionId: string): boolean
  /** Launch one hidden wake run and resolve when it fully finishes. */
  runWake(sessionId: string, prompt: string, opts?: WakeRunOptions): Promise<WakeRunOutcome>
  /**
   * Best-effort interrupt of the session's in-flight run (Plan 495 G3,
   * 476 §2.2 preemption). Optional: tests and embedders may omit it, in
   * which case preempting wakes fall back to parking.
   */
  interruptRun?(sessionId: string): void
}

/** Per-run options resolved by the dispatcher (477 P3.1; see wake-run.ts). */
export type { WakeRunOptions, WakeRunOutcome } from './wake-run'

interface SessionWakeState {
  queue: WakeQueue
  draining: boolean
  /** The wake item whose run this dispatcher is currently awaiting. */
  runningItem?: WakeItem
  /** Displaced item awaiting its run's return so it can re-queue redriven. */
  redrivePending?: WakeItem
}

/** In-memory recently-dispatched dedupe (476 P0-D; Phase 3 → pending_wakes). */
const recentWakeTaskIds = new Map<string, number>()
const DEDUPE_WINDOW_MS = 60_000
const DEDUPE_MAX_ENTRIES = 500

const sessions = new Map<string, SessionWakeState>()

/**
 * Turn epoch (476 §2.6, E3): per-session counter advanced only when a
 * *user* turn starts (db-bridge lock:acquire with userTurn=true calls
 * `advanceUserTurn`). Background wakes are stamped with the epoch at
 * enqueue time; when they are finally dispatched after a user turn that
 * superseded them, the drain skips them — the user has already taken over
 * the conversation, so the stale background wake must not interrupt.
 */
let turnEpochs = createTurnEpochState()

/** Default wiring — lazy so unit tests can inject fakes first. */
let activeDeps: WakeDispatcherDeps | null = null

export function _setWakeDispatcherDeps(impl: WakeDispatcherDeps): void {
  activeDeps = impl
}

function currentDeps(): WakeDispatcherDeps {
  if (!activeDeps) {
    activeDeps = {
      isLocked(sessionId) {
        try {
          return getCoreStores().locks.isLocked(sessionId)
        } catch {
          return false
        }
      },
      runWake: (sessionId, prompt, opts) => runWakePromptInExistingSession(sessionId, prompt, opts),
      interruptRun: (sessionId) => interruptCronSession(sessionId),
    }
  }
  return activeDeps
}

/**
 * Enqueue a wake for a session and kick the dispatch loop. Returns the
 * outcome: 'added' (new item), 'merged' (replaced an identical queued item)
 * or 'deduped' (same taskId dispatched within the recent window).
 */
export function enqueueWakeItemForSession(
  sessionId: string,
  item: WakeItem,
): 'added' | 'merged' | 'deduped' {
  const now = Date.now()

  const state = getState(sessionId)

  // Queue merge takes precedence over the recently-dispatched window: when
  // an identical item is still parked in the queue (e.g. session was busy),
  // re-notification replaces it in place ('merged'). Only when the queue has
  // no such item AND we already dispatched this taskId within the window do
  // we suppress the wake entirely ('deduped').
  const alreadyQueued = hasQueuedItem(state.queue, item.id)
  if (!alreadyQueued && !item.isRedriven && item.payload.kind === 'completion') {
    // Plan 495 G3: redriven items bypass the recently-dispatched window —
    // they were re-queued deliberately after preemption, not re-notified.
    const lastAt = recentWakeTaskIds.get(item.payload.taskId)
    if (lastAt != null && now - lastAt < DEDUPE_WINDOW_MS) return 'deduped'
  }

  // Stamp the turn epoch at enqueue time (476 P2.5) — an immutable copy so
  // the caller's object is never mutated. A wake enqueued before a user turn
  // is superseded once that turn advances the epoch; the drain then skips
  // it instead of interrupting the user's new conversation.
  const stamped = item.turnEpoch == null
    ? { ...item, turnEpoch: turnEpochs.current(sessionId) }
    : item

  const { queue, outcome } = enqueueWake(state.queue, stamped)

  if (outcome === 'added' && item.payload.kind === 'completion') {
    recentWakeTaskIds.set(item.payload.taskId, now)
    sweepDedupeMap(now)
  }

  state.queue = queue
  kick(sessionId)
  // Plan 495 G3 / 476 §2.2: preemption is decided at enqueue time — the
  // drain loop is blocked awaiting the in-flight runWake, so a preempting
  // wake that arrives mid-run must interrupt from here, not wait for the
  // next drain pass.
  if (outcome === 'added') tryPreemptRunning(sessionId, stamped)
  return outcome
}

/**
 * Preemption decision for an incoming wake against the dispatcher-owned
 * run in flight (Plan 495 G3, grok send-turn-dispatch parity):
 *  - only when the session is locked (busy) and THIS dispatcher started
 *    the running wake (`runningItem` attribution — a renderer chat or cron
 *    holding the lock is never interrupted);
 *  - only when `decidePreemption` says the incoming wake preempts (user
 *    message / priority DM vs a non-user run);
 *  - once per displaced run (`redrivePending` guard).
 *
 * The displaced run is interrupted; when its runWake returns, the drain
 * re-queues it with `isRedriven: true` so the work is not lost.
 */
function tryPreemptRunning(sessionId: string, incoming: WakeItem): void {
  const state = getState(sessionId)
  if (!currentDeps().isLocked(sessionId)) return
  const running = state.runningItem
  if (!running || state.redrivePending) return
  if (running.id === incoming.id) return
  const decision = decidePreemption(incoming, runOriginOf(running))
  if (decision.action !== 'preempt') return
  // Preempting wakes start a new epoch so the displaced run's tail
  // side-effects stand down (476 §2.6 tail guard).
  turnEpochs.maybeAdvanceForItem(sessionId, incoming)
  state.redrivePending = running
  getLogger().info('Wake preemption: interrupting in-flight run', {
    sessionId,
    displacedSource: running.source,
    incomingSource: incoming.source,
    reason: decision.reason,
  }, LogComponent.Automation)
  try {
    currentDeps().interruptRun?.(sessionId)
  } catch (err) {
    getLogger().warn('Wake preemption: interrupt failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    }, LogComponent.Automation)
  }
}

/**
 * Advance the session's turn epoch — called by main (db-bridge) when a
 * user-initiated run starts (lock:acquire with userTurn=true). Background
 * wakes and automation runs never call this (476 §2.6).
 */
export function advanceUserTurn(sessionId: string): number {
  return turnEpochs.advance(sessionId)
}

/** Current turn epoch for a session (0 when never advanced). */
export function currentTurnEpoch(sessionId: string): number {
  return turnEpochs.current(sessionId)
}

/** Broadcast payload clamp (476 §2.3, aligned with background-wakes.ts). */
export const BROADCAST_MAX_CHARS = 8000

/**
 * Plan 476 P2.4 — broadcast (internal API, minimal slice). Enqueue one
 * broadcast wake per target session on the background lane. The text is
 * clamped to 8000 chars here; dedupe is by `broadcast:<id>` so re-sending
 * the same broadcast to a session still queued collapses to one item.
 */
export function enqueueBroadcastWake(opts: {
  broadcastId: string
  text: string
  targetSessionIds: readonly string[]
}): Array<'added' | 'merged' | 'deduped'> {
  const text = opts.text.slice(0, BROADCAST_MAX_CHARS)
  const now = Date.now()
  return opts.targetSessionIds.map((sessionId) =>
    enqueueWakeItemForSession(sessionId, {
      id: `broadcast:${opts.broadcastId}`,
      source: 'broadcast',
      lane: 'background',
      agentId: sessionId,
      enqueuedAtMs: now,
      payload: { kind: 'broadcast', broadcastId: opts.broadcastId, text },
    }),
  )
}

/**
 * Plan 476 P2.3c — connector.inbound (dispatcher layer). An external
 * channel message mapped to a session enqueues as a background wake; the
 * drain launches it when the session is idle. Dedupe by envelope id.
 *
 * Note for the gateway wiring (later phase): today's gateway:inbound path
 * replies to the channel via SSE forwarding that lives inline in
 * message-bus.ts, so routing it through this queue requires an inbound
 * executor that keeps that channel reply chain (a hidden runPromptInSession
 * wake has no SSE channel back). This function + the prompt branch below
 * are the queue half; the executor injection is the gateway half.
 */
export function enqueueInboundWake(
  sessionId: string,
  opts: { envelopeId: string; text?: string },
): 'added' | 'merged' | 'deduped' {
  const now = Date.now()
  const text = (opts.text ?? '').trim()
  return enqueueWakeItemForSession(sessionId, {
    id: `inbound:${opts.envelopeId}`,
    source: 'connector.inbound',
    lane: 'background',
    agentId: sessionId,
    enqueuedAtMs: now,
    payload: {
      kind: 'inbound',
      envelopeId: opts.envelopeId,
      ...(text ? { text: text.slice(0, BROADCAST_MAX_CHARS) } : {}),
    },
  })
}

/**
 * Called by the main process when a session's run finishes (db-bridge
 * `lock:release`). Re-kicks the drain loop so parked background wakes
 * continue after a user turn that pre-empted them.
 */
export function notifySessionIdle(sessionId: string): void {
  kick(sessionId)
}

/** Drop every queued wake for a session (agent deleted / session reset). */
export function clearSessionWakes(sessionId: string): void {
  sessions.delete(sessionId)
}

/** Remove queued wakes matching a predicate (cancelled task etc). */
export function removeQueuedWake(
  sessionId: string,
  predicate: (item: WakeItem) => boolean,
): WakeItem[] {
  const state = sessions.get(sessionId)
  if (!state) return []
  const { queue, removed } = removeWakeWhere(state.queue, predicate)
  state.queue = queue
  return removed
}

function getState(sessionId: string): SessionWakeState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { queue: createWakeQueue(), draining: false }
    sessions.set(sessionId, state)
  }
  return state
}

/** Whether an item with the same dedupe id is already parked in the queue. */
function hasQueuedItem(queue: WakeQueue, id: string): boolean {
  return (
    queue.pending.user.some((item) => item.id === id) ||
    queue.pending.agent.some((item) => item.id === id) ||
    queue.pending.background.some((item) => item.id === id)
  )
}

/** Start a drain pass when possible. */
function kick(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  if (state.draining) return
  if (currentDeps().isLocked(sessionId)) return // busy — release will re-kick
  void drain(sessionId)
}

async function drain(sessionId: string): Promise<void> {
  const state = getState(sessionId)
  if (state.draining) return
  state.draining = true
  try {
    for (;;) {
      const head = peekNextWake(state.queue)
      if (!head) break
      if (currentDeps().isLocked(sessionId)) {
        // Plan 495 G3 / 476 §2.2 + §6.4: preempt a dispatcher-owned run
        // when the queued head is a preempting wake (user message /
        // priority DM); the displaced run redrives after the preempting
        // turn finishes. The enqueue path covers the mid-run case (the
        // drain is blocked awaiting runWake); this covers items already
        // parked when a user turn took the lock.
        tryPreemptRunning(sessionId, head)
        break
      }

      const dequeued = dequeueNextWake(state.queue)
      if (!dequeued) break
      state.queue = dequeued.queue

      // 476 P2.5: skip background wakes that a newer user turn superseded
      // while they were parked. item.turnEpoch was stamped at enqueue; once
      // a user message advanced the session epoch, a stale background wake
      // is noise — the user has taken over the conversation. Agent-lane DMs
      // (477) and user-lane items are NOT dropped: a DM is the bot's own
      // inbox, so it queues behind the user turn and runs in lane order
      // instead of being silently lost. Plan 495 G3: redriven items are
      // exempt too — they were re-queued precisely so the displaced work
      // still happens once the preempting turn finishes.
      const epoch = dequeued.item.turnEpoch
      if (
        dequeued.item.lane === 'background' &&
        !dequeued.item.isRedriven &&
        epoch != null &&
        !turnEpochs.isCurrent(sessionId, epoch)
      ) {
        getLogger().debug('Wake skipped: superseded by newer user turn', {
          sessionId,
          source: dequeued.item.source,
          itemEpoch: epoch,
          currentEpoch: turnEpochs.current(sessionId),
        }, LogComponent.Automation)
        continue
      }

      // 488 Plan B: connector.inbound items are handled by the channel system
      // via reviveForInbound which builds the rich [inbound] prompt from stored
      // envelopes. Fire-and-forget — reviveForInbound acquires its own lock via
      // runWakePromptInExistingSession (no deadlock risk). Errors are logged
      // inside reviveForInbound and do not wedge the drain loop.
      if (dequeued.item.source === 'connector.inbound') {
        void reviveForInbound(sessionId).catch((err) => {
          getLogger().warn('WakeDispatcher: reviveForInbound threw', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          }, LogComponent.AgentProcess)
        })
        continue
      }

      const prompt = promptForItem(dequeued.item)
      if (!prompt) continue
      // NOTE (Plan 495 G3): dispatching a user-lane wake does NOT advance
      // the epoch — the existing 476/477 contract keeps background wakes
      // queued behind a user wake running in lane order (they are the
      // bot's inbox, not noise). The epoch advances only when main sees a
      // real user turn (lock:acquire userTurn=true) or on preemption below.
      // This run owns the epoch it was dispatched under, so the tail guard
      // only fires when the epoch advances *mid-run*.
      const dispatchEpoch = turnEpochs.current(sessionId)
      // 477 P3.1: a bot persistent session (`bot:<agentId>`) runs with the
      // bot's profile so the woken worker builds the bot toolset and 474
      // prompt sections. The fixed session id is the binding itself — the
      // agent id parses straight out of it, no lookup needed.
      const botAgentId = parseAgentIdFromBotSession(sessionId)
      state.runningItem = dequeued.item
      try {
        const outcome = await currentDeps().runWake(
          sessionId,
          prompt,
          botAgentId ? { agentProfileId: botAgentId } : undefined,
        )
        state.runningItem = undefined
        // Plan 495 G3 redrive: if this run was displaced by a preempting
        // wake, re-queue the item (epoch re-stamped at enqueue) so the work
        // still happens after the preempting turn finishes.
        if (state.redrivePending?.id === dequeued.item.id) {
          state.redrivePending = undefined
          const requeued = asRedriven({ ...dequeued.item, turnEpoch: undefined })
          getLogger().info('Wake redrive: re-queueing displaced run', {
            sessionId,
            source: requeued.source,
          }, LogComponent.Automation)
          enqueueWakeItemForSession(sessionId, requeued)
        }
        // Plan 495 G3 — run tail epoch guard (grok turn-runtime parity):
        // when this item's epoch is no longer current, a newer user turn
        // superseded the run and its user-facing tail side-effects must
        // stand down (no auto-return, grok "旧回合不 nudge 不上报").
        const tailSuppressed = turnEpochs.current(sessionId) !== dispatchEpoch
        if (tailSuppressed) {
          getLogger().debug('Wake run tail suppressed: superseded by newer user turn', {
            sessionId,
            source: dequeued.item.source,
            dispatchEpoch,
            currentEpoch: turnEpochs.current(sessionId),
          }, LogComponent.Automation)
        } else if (dequeued.item.payload.kind === 'dm' && outcome) {
          // 477 P4.3 — auto-return: a DM run whose inbound message was a
          // request/question hands its final response back to the delegating
          // bot unless the bot already replied explicitly during the run.
          // Outcome fields are read defensively: injected test deps may return
          // void (legacy fakes).
          const dm = dequeued.item.payload
          if (!runUsedSendToAgent(outcome.events ?? [])) {
            maybeAutoReturnDmResult(
              {
                sessionId,
                clientMsgId: dm.clientMsgId,
                fromAgentId: dm.fromAgentId,
                ...(dm.fromAgentName ? { fromAgentName: dm.fromAgentName } : {}),
                ...(dm.intent ? { intent: dm.intent } : {}),
                ...(dm.hops != null ? { hops: dm.hops } : {}),
              },
              outcome.output ?? '',
            )
          }
        }
      } catch (err) {
        state.runningItem = undefined
        // Plan 495 G3: a displaced run re-queues even on failure, so an
        // interrupted item is never silently dropped.
        if (state.redrivePending?.id === dequeued.item.id) {
          state.redrivePending = undefined
          enqueueWakeItemForSession(sessionId, asRedriven({ ...dequeued.item, turnEpoch: undefined }))
        }
        // runWake is best-effort and swallows most failures; this guard is
        // for unexpected throws so one bad item cannot wedge the queue.
        getLogger().warn('Wake run failed', {
          sessionId,
          source: dequeued.item.source,
          error: err instanceof Error ? err.message : String(err),
        }, LogComponent.Automation)
      }
    }
  } finally {
    state.draining = false
  }
}

/**
 * Attribute a dispatched wake item to the origin that started its run
 * (Plan 495 G3; grok RunOrigin). Only user-origin runs are immune to
 * preemption — a user turn is driving, everything else yields.
 */
function runOriginOf(item: WakeItem): RunOrigin {
  if (item.lane === 'user') return 'user'
  if (item.lane === 'agent') return 'bot'
  return 'background'
}

/** Build the model-facing prompt for an item. Empty string = skip silently. */
function promptForItem(item: WakeItem): string {
  switch (item.payload.kind) {
    case 'completion': {
      const summary = (item.payload.summary ?? '').trim()
      const label = item.payload.title ? ` (${item.payload.title})` : ''
      return summary
        ? `[system] A background task finished${label}:\n${summary}\n\nReview the result above and reply to the user if there is something worth reporting.`
        : `[system] A background task completed (${item.payload.taskId}). Review its result and continue if useful.`
    }
    case 'broadcast': {
      const body = (item.payload.text ?? '').trim()
      return body
        ? `[system] Admin broadcast (${item.payload.broadcastId}):\n${body}\n\nReview it and act if it concerns you.`
        : `[system] An admin broadcast (${item.payload.broadcastId}) was sent. Review and act if it concerns you.`
    }
    case 'inbound': {
      const body = (item.payload.text ?? '').trim()
      return body
        ? `[system] A message arrived from an external channel (envelope ${item.payload.envelopeId}):\n${body}\n\nRespond to the sender if appropriate.`
        : `[system] A message arrived from an external channel (envelope ${item.payload.envelopeId}). Respond to the sender if appropriate.`
    }
    case 'user': {
      // A user message parked in the queue (session was busy when it
      // arrived). Dispatch = run it as the user's turn.
      return (item.payload.text ?? '').trim() || '[system] Continue with the user request.'
    }
    case 'approval': {
      // Plan 498: a durable approval card was decided (possibly long after
      // the paused turn ended). The allow path's replay is authorized by the
      // one-shot approval ledger (toolApproval:consumeApproved in canUseTool),
      // so the model can simply retry the call — nothing else is pre-approved.
      const p = item.payload
      if (p.decision === 'deny') {
        return (
          `[system] The user DENIED the pending "${p.toolName}" tool call (approval ${p.approvalId}). ` +
          `Do not retry it. Continue without it, or tell the user what you need instead.`
        )
      }
      const always =
        p.decision === 'always'
          ? ' This tool is now allowed for your future turns as well.'
          : ''
      return (
        `[system] The user APPROVED the pending "${p.toolName}" tool call (approval ${p.approvalId}). ` +
        `Retry that call now with the same arguments you intended.${always}`
      )
    }
    case 'dm': {
      // 477 P3.1: a bot→bot DM wake. The envelope text was persisted in the
      // mailbox row; rebuild the grok-style inbound cue from the payload so
      // the receiver understands the message came from another agent (not
      // the user) and replies via SendToAgent, not SendMessage.
      const text = (item.payload.text ?? '').trim()
      const fromId = (item.payload.fromAgentId ?? '').trim()
      const fromName = (item.payload.fromAgentName ?? '').trim()
      if (!text || !fromId) return ''
      return buildAgentInboundWakePrompt({
        from: { id: fromId, name: fromName || fromId },
        // The receiver is the session this wake is dispatched to.
        to: { id: parseAgentIdFromBotSession(item.agentId) ?? item.agentId, name: '' },
        text,
        ...(item.payload.priority ? { priority: true } : {}),
        // Plan 477 P4.1 — intent drives the action paragraph; the cast is
        // safe because the dispatcher only forwards validated AgentDmIntent
        // values (unknown strings degrade to the default paragraph inside
        // the builder).
        ...(item.payload.intent ? { intent: item.payload.intent as Parameters<typeof buildAgentInboundWakePrompt>[0]['intent'] } : {}),
        timestampMs: item.enqueuedAtMs,
        clientMsgId: item.payload.clientMsgId ?? item.id,
      })
    }
    default:
      // automation (P2.3b) is wired by a later phase; skipping is safe —
      // the source still persists its own state.
      return ''
  }
}

function sweepDedupeMap(now: number): void {
  if (recentWakeTaskIds.size <= DEDUPE_MAX_ENTRIES) return
  for (const [key, ts] of recentWakeTaskIds) {
    if (now - ts > DEDUPE_WINDOW_MS) recentWakeTaskIds.delete(key)
  }
}

/** Test seam: reset module state (queues, dedupe, epochs, injected deps). */
export function _resetWakeDispatcherForTest(): void {
  sessions.clear()
  recentWakeTaskIds.clear()
  turnEpochs = createTurnEpochState()
  activeDeps = null
}

/** Test seam: read how many items are queued for a session. */
export function _queuedWakeCount(sessionId: string): number {
  return sessions.get(sessionId)?.queue.size ?? 0
}
