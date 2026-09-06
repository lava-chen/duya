/**
 * wake/types.ts — Agent Wake Bus shared types (Plan 476 §2.1, §2.3).
 *
 * Pure types + small pure helpers only. This module never touches the
 * runtime (no IPC, no DB): the authoritative WakeQueue loop lives in the
 * Electron main process (Plan 476 §6.1), while everything here is safe to
 * unit-test and to import from both the worker and the main process.
 *
 * Lane ordering follows grok's run-scheduler: user > agent > background.
 * A session runs one exclusive run at a time; the head lane decides what
 * executes next. `turnEpoch` (E3, see overview plan 473 §2.5.1) lets the
 * runtime tell a superseded turn's tail side-effects (nudge, error
 * reporting) to stand down.
 */

/** Three-lane scheduling (grok run-scheduler parity). */
export type WakeLane = 'user' | 'agent' | 'background'

/**
 * Wake origin taxonomy — first-phase registry (Plan 476 §2.3). Each source
 * owns its dedupe key semantics so the queue can collapse duplicates.
 */
export type WakeSourceKind =
  | 'task.completion' // background: subagent/shell finished (dedupe: taskId)
  | 'automation.fire' // background: cron/event automation (dedupe: jobKey+fireKey)
  | 'connector.inbound' // background: gateway inbound (dedupe: envelope id)
  | 'broadcast' // background: admin broadcast (dedupe: broadcast id)
  | 'agent.dm' // agent: bot→bot message, priority-capable (dedupe: clientMsgId)
  | 'user.message' // user: direct chat dispatch (dedupe: —)
  | 'approval.resume' // agent: durable approval-card decision resumed the run (dedupe: approvalId)
  | 'group.turn' // agent: shared-room member turn (Plan 500 P4; dedupe: unique per run)

/** Lane for each source kind (compile-time mirror of 476 §2.3). */
export const SOURCE_DEFAULT_LANE: Readonly<Record<WakeSourceKind, WakeLane>> = {
  'task.completion': 'background',
  'automation.fire': 'background',
  'connector.inbound': 'background',
  broadcast: 'background',
  'agent.dm': 'agent',
  'user.message': 'user',
  // Plan 498: an approval decision is user-authored but must not preempt a
  // turn in flight — it queues as agent-lane work (behind user turns).
  'approval.resume': 'agent',
  // Plan 500 P4: room member turns are agent-lane work on the member's own
  // session — they queue behind user DMs and yield to user preemption.
  'group.turn': 'agent',
}

/**
 * Whether this source kind may preempt a non-user run. Only direct user
 * turns and priority DMs preempt (476 §2.2; grok agent-to-agent-messaging).
 */
export function sourceCanPreempt(source: WakeSourceKind): boolean {
  return source === 'user.message' || source === 'agent.dm'
}

/** Quiet-work marker: automation wake whose completed items are all quiet. */
export interface QuietWakeOrigin {
  automation?: { id: string; name: string }
}

/**
 * Source payload — discriminated union. Concrete shapes are filled by each
 * wiring plan (476 P2, 477 for agent.dm, 482 for external agents); today we
 * only pin the discriminant + ids that dedupe needs.
 */
export type WakePayload =
  | { kind: 'completion'; taskId: string; title?: string; quiet?: boolean; summary?: string }
  | {
      kind: 'automation'
      jobKey: string
      fireKey: string
      name?: string
      quiet?: boolean
      /** P2.3b — which fire path produced this item (drives the wake prompt opening). */
      trigger?: 'schedule' | 'manual' | 'event'
      /** P2.3d — event fires: one-line summary + pre-rendered context blocks. */
      eventSummary?: string
      eventContext?: string
    }
  | { kind: 'inbound'; envelopeId: string; text?: string }
  | { kind: 'broadcast'; broadcastId: string; text: string }
  | {
      kind: 'dm'
      clientMsgId: string
      fromAgentId: string
      fromAgentName?: string
      text: string
      priority?: boolean
      /** Plan 477 P4.1 — sender intent (drives wake prompt + auto-return). */
      intent?: string
      /** Plan 477 P4.2 — computed bot→bot hop depth (dispatcher-enforced). */
      hops?: number
    }
  | { kind: 'user'; text: string; messageId?: string }
  | {
      /** Plan 498: a persisted approval card was decided; resume the run. */
      kind: 'approval'
      approvalId: string
      toolName: string
      decision: 'allow' | 'always' | 'deny'
      text: string
    }
  | {
      /** Plan 500 P4: a shared-room member turn on this bot's session. */
      kind: 'group'
      roomId: string
      text: string
    }

/** Dedupe key of an item (the queue collapses on it). */
export function wakeDedupeKey(item: WakeItem): string {
  switch (item.payload.kind) {
    case 'completion':
      return `task:${item.payload.taskId}`
    case 'automation':
      return `auto:${item.payload.jobKey}:${item.payload.fireKey}`
    case 'inbound':
      return `inbound:${item.payload.envelopeId}`
    case 'broadcast':
      return `broadcast:${item.payload.broadcastId}`
    case 'dm':
      return `dm:${item.payload.clientMsgId}`
    case 'approval':
      return `approval:${item.payload.approvalId}`
    case 'user':
      return item.payload.messageId == null
        ? `user:${item.enqueuedAtMs}`
        : `user:${item.payload.messageId}`
    case 'group':
      // Every member turn is a distinct run — the id is supplied by the
      // dispatcher (`group:<roomId>:<epoch>:<memberId>:<nonce>`), so the
      // dedupe key is the id itself.
      return `group:${item.payload.roomId}:${item.id}`
  }
}

/** A single pending wake for one agent/bot. */
export interface WakeItem {
  /** Dedupe key (supplied by source via wakeDedupeKey). */
  id: string
  source: WakeSourceKind
  lane: WakeLane
  agentId: string
  enqueuedAtMs: number
  /** E3 turn epoch: assigned by main at dispatch for user/priority lanes. */
  turnEpoch?: number
  quietOrigin?: QuietWakeOrigin
  payload: WakePayload
  /** True when this item was re-queued after being preempted. */
  isRedriven?: boolean
}

/** Priority flag derived from the item (user or priority DM preempts). */
export function isPreemptingItem(item: WakeItem): boolean {
  if (item.lane === 'user') return true
  return item.source === 'agent.dm' && item.payload.kind === 'dm' && item.payload.priority === true
}

/** Lane rank for strict ordering: user(0) > agent(1) > background(2). */
export const LANE_RANK: Readonly<Record<WakeLane, number>> = {
  user: 0,
  agent: 1,
  background: 2,
}
