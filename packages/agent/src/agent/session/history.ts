/**
 * history.ts - HistoryStore
 *
 * Encapsulates the append-only MessageTimeline write surface for the agent
 * runtime. This is Phase 4+5 of Plan 334: it lifts the timeline append /
 * rebuild / clear semantics out of `DuyaAgent`'s private helpers into a
 * standalone store that a rewritten `DuyaAgent` or the future agent-loop layer
 * can reference.
 *
 * Contract:
 * - The timeline is the single source of truth for history. It is append-only.
 *   `appendMessage` / `appendRuntimeContext` / `addMessage` may only grow it;
 *   `rebuild` / `clear` replace the whole timeline object.
 * - O(1) dedup: `syncedMessageIds` records every message id already appended so
 *   duplicate writes are no-ops. Attachment runtime-context is additionally
 *   deduplicated by its attachment-id set.
 * - This store does NOT own `SessionInfo` counters; the host updates those from
 *   `snapshot()` / the persistence projection.
 */

import type { Message } from '../../types.js';
import {
  MessageTimeline,
  ingestMessage,
  getLegacyCompactionCheckpoint,
  type CompactionEntry,
  type MessageTimelineEntry,
  type RuntimeContextAgentMessage,
  type AgentMessage,
} from '../../message/index.js';
import { RUNTIME_CONTEXT_METADATA_KEYS } from '../../message/runtime-context-adapters.js';
import { extractTextFromContent } from '../utils/agent-helpers.js';

/**
 * Append-only history store backed by a {@link MessageTimeline}.
 */
export class HistoryStore {
  private timeline: MessageTimeline;
  private syncedMessageIds: Set<string>;

  constructor() {
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
  }

  /** The underlying timeline. Read-only handle for projectors / compaction. */
  getTimeline(): MessageTimeline {
    return this.timeline;
  }

  /** Snapshot of the current timeline entries. */
  snapshot(): readonly MessageTimelineEntry[] {
    return this.timeline.snapshot();
  }

  /**
   * Append a durable provider message to the timeline if not already present.
   * O(1) dedup via {@link syncedMessageIds}. No-op when the message has no id
   * or is already synced.
   */
  appendMessage(message: Message): void {
    if (!message.id || this.syncedMessageIds.has(message.id)) return;
    const snapshot = this.timeline.snapshot();
    const index = snapshot.length;
    const adapted = ingestMessage(message, { index });
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${index}`,
      parentId: null,
      createdAt: adapted.timestamp ?? 0,
      message: adapted,
    });
    this.syncedMessageIds.add(message.id);
  }

  /**
   * Append a native runtime_context message to the timeline with dedup.
   * For `source='attachment'`, dedup by attachmentIds metadata (the same set
   * of attachments is not recorded twice). Returns true when the message was
   * appended, false if it was deduplicated as already present.
   */
  appendRuntimeContext(message: RuntimeContextAgentMessage): boolean {
    if (!message.id || this.syncedMessageIds.has(message.id)) return false;
    if (message.source === 'attachment') {
      const ids = (message.metadata?.[
        RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string
      ] ?? []) as unknown[];
      const attachmentIds = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (attachmentIds.length > 0 && this.hasAttachmentRuntimeContext(attachmentIds)) {
        return false;
      }
    }
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${this.timeline.snapshot().length}`,
      parentId: null,
      createdAt: message.timestamp,
      message: message as AgentMessage,
    });
    this.syncedMessageIds.add(message.id);
    return true;
  }

  /**
   * True when any attachment runtime_context entry in the current timeline
   * carries every one of the supplied attachment IDs.
   */
  hasAttachmentRuntimeContext(attachmentIds: readonly string[]): boolean {
    if (attachmentIds.length === 0) return false;
    const snapshot = this.timeline.snapshot();
    for (const entry of snapshot) {
      if (entry.type !== 'message') continue;
      const msg = entry.message as unknown as Record<string, unknown>;
      if (msg.kind !== 'runtime_context') continue;
      if ((msg as { source?: string }).source !== 'attachment') continue;
      const md = (msg as { metadata?: Readonly<Record<string, unknown>> }).metadata;
      const ids = (md?.[RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds as string] ?? []) as unknown[];
      const existingIds = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
      if (
        existingIds.length === attachmentIds.length &&
        existingIds.every((id) => attachmentIds.includes(id))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rebuild the entire timeline from a legacy persistence-shaped `Message[]`.
   * A Plan 315 checkpoint marker is reconstructed as a {@link CompactionEntry}
   * and appended AFTER the retained messages so `buildAgentContext` restores
   * the compaction boundary and reinjected system context after a restart.
   */
  rebuild(messages: Message[]): void {
    let compaction: CompactionEntry | undefined;
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
    for (const [index, message] of messages.entries()) {
      const checkpoint = getLegacyCompactionCheckpoint(message);
      if (checkpoint) {
        compaction = {
          type: 'compaction',
          id: checkpoint.id,
          parentId: null,
          createdAt: checkpoint.createdAt,
          summary: extractTextFromContent(message.content),
          firstKeptMessageId: checkpoint.firstKeptMessageId,
          compactedMessageIds: [...checkpoint.compactedMessageIds],
          tokensBefore: checkpoint.tokensBefore,
          tokensAfter: checkpoint.tokensAfter,
          strategy: checkpoint.strategy,
          previousCompactionId: checkpoint.previousCompactionId,
          reinjectedSystemMessages: checkpoint.reinjectedSystemMessages,
        };
        continue;
      }
      const adapted = ingestMessage(message, { index });
      this.timeline.appendMessage({
        type: 'message',
        id: `${crypto.randomUUID()}:${index}`,
        parentId: null,
        createdAt: adapted.timestamp ?? 0,
        message: adapted,
      });
      if (message.id) this.syncedMessageIds.add(message.id);
    }
    if (compaction) {
      this.timeline.appendCompaction(compaction);
    }
  }

  /**
   * Clear all messages from the timeline and the dedup set.
   */
  clear(): void {
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
  }

  /**
   * Add a user message with a defaulted timestamp. The message id is required
   * for dedup; callers that produce id-less user messages should assign one
   * first.
   */
  addMessage(message: Message): void {
    const withTimestamp: Message = {
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    };
    const snapshot = this.timeline.snapshot();
    const index = snapshot.length;
    const adapted = ingestMessage(withTimestamp, { index });
    this.timeline.appendMessage({
      type: 'message',
      id: `${crypto.randomUUID()}:${index}`,
      parentId: null,
      createdAt: adapted.timestamp ?? 0,
      message: adapted,
    });
    if (withTimestamp.id) {
      this.syncedMessageIds.add(withTimestamp.id);
    }
  }
}