/**
 * Transport-neutral contract for queued Agent wake work.
 *
 * The Host persists these values and dispatches them to workers. Keep this
 * module free of storage, process, Electron, and transport dependencies.
 */

/** Three-lane scheduling: direct user work, agent work, then background work. */
export type WakeLane = 'user' | 'agent' | 'background'

/** Wake origin taxonomy. Each source owns its dedupe key semantics. */
export type WakeSourceKind =
  | 'task.completion'
  | 'automation.fire'
  | 'connector.inbound'
  | 'broadcast'
  | 'agent.dm'
  | 'user.message'
  | 'approval.resume'
  | 'group.turn'
  | 'bot.kickstart'

/** Default queue lane for each wake source. */
export const SOURCE_DEFAULT_LANE: Readonly<Record<WakeSourceKind, WakeLane>> = {
  'task.completion': 'background',
  'automation.fire': 'background',
  'connector.inbound': 'background',
  broadcast: 'background',
  'agent.dm': 'agent',
  'user.message': 'user',
  'approval.resume': 'agent',
  'group.turn': 'agent',
  'bot.kickstart': 'background',
}

/** Whether this source may preempt a non-user run. */
export function sourceCanPreempt(source: WakeSourceKind): boolean {
  return source === 'user.message' || source === 'agent.dm'
}

/** Quiet-work marker for automation wakes whose completed items are quiet. */
export interface QuietWakeOrigin {
  automation?: { id: string; name: string }
}

/** Payload carried by a queued wake. */
export type WakePayload =
  | { kind: 'completion'; taskId: string; title?: string; quiet?: boolean; summary?: string }
  | {
      kind: 'automation'
      jobKey: string
      fireKey: string
      name?: string
      quiet?: boolean
      trigger?: 'schedule' | 'manual' | 'event'
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
      intent?: string
      hops?: number
    }
  | { kind: 'user'; text: string; messageId?: string; attachments?: readonly FileAttachment[] }
  | {
      kind: 'approval'
      approvalId: string
      toolName: string
      decision: 'allow' | 'always' | 'deny'
      text: string
    }
  | { kind: 'group'; roomId: string; text: string }

/** A single pending wake for one agent or bot session. */
export interface WakeItem {
  /** Dedupe key supplied by the source. */
  id: string
  source: WakeSourceKind
  lane: WakeLane
  agentId: string
  enqueuedAtMs: number
  /** Turn epoch assigned by the Host for user and priority lanes. */
  turnEpoch?: number
  quietOrigin?: QuietWakeOrigin
  payload: WakePayload
  /** True when this item was re-queued after being preempted. */
  isRedriven?: boolean
  /** Number of times this item has been displaced and re-queued. */
  redriveCount?: number
}

/** Dedupe key of an item. */
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
      return `group:${item.payload.roomId}:${item.id}`
  }
}

/** Priority flag derived from the item. */
export function isPreemptingItem(item: WakeItem): boolean {
  if (item.lane === 'user') return true
  return item.source === 'agent.dm' && item.payload.kind === 'dm' && item.payload.priority === true
}

/** Lane rank for strict ordering: user (0), agent (1), background (2). */
export const LANE_RANK: Readonly<Record<WakeLane, number>> = {
  user: 0,
  agent: 1,
  background: 2,
}
import type { FileAttachment } from './file-attachment.js'
