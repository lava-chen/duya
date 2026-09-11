/**
 * Journal — agent-core event-level persistence trigger (plan 441).
 *
 * Wraps three semantic event boundaries in the agent loop:
 *   - `userMsgAdded`         — user message entered the timeline
 *   - `assistantMsgFinalized` — assistant message (text OR tool_use) closed
 *   - `toolResultAdded`       — a tool result entered the timeline
 *   - `hookInvoked`           — a hook event emitted
 *   - `appendRebase`          — compaction / edit-resend rebases the trace
 *
 * Each emit is fire-and-forget against the main-process `MessageLog` via
 * IPC. The agent loop MUST NOT block on persistence — turns are seconds-to-
 * minutes long and a single slow write should not stall the stream.
 *
 * Idempotency: every event carries a deterministic id built from the source
 * message id + event kind. `MessageLog.appendBatch` uses INSERT OR IGNORE
 * on the index's primary key, so re-emits of the same boundary (e.g. from
 * a retry after process crash) are silently dropped.
 *
 * Crash window: at most one in-flight tool call is lost on a hard kill
 * (the agent's _pushDurable for that tool result did not run, so its
 * journal emit never fired). User messages and completed assistant /
 * tool_result messages are durable at the moment their respective boundary
 * closes. Compare to the old turn-end batch which lost the ENTIRE turn on
 * the same crash.
 */

import { messageDb } from '../ipc/db-client.js';
import type { MessageEntry } from '@duya/agent/message';
import type { Message } from '../message/index.js';
import { ingestMessage } from '../message/message-factories.js';
import { THREAD_METADATA_KEY } from '../message/threads.js';
import type { RolloutEvent } from './types.js';

// Re-export so callers can use the agent-core RolloutEvent union.
export type { RolloutEvent } from './types.js';

export interface JournalOptions {
  sessionId: string;
  /** Optional logger hook for fire-and-forget failures. */
  onError?: (kind: string, err: unknown) => void;
}

export class Journal {
  private readonly sessionId: string;
  private readonly onError: (kind: string, err: unknown) => void;
  /** In-flight emit promises — drained by flush() before the turn-end ack. */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: JournalOptions) {
    this.sessionId = opts.sessionId;
    this.onError =
      opts.onError ??
      ((kind, err) => {
        // eslint-disable-next-line no-console
        console.warn(`[Journal] ${kind} persist failed:`, err instanceof Error ? err.message : String(err));
      });
  }

  /** Emit user_msg_added when the user message enters the timeline. */
  userMsgAdded(msg: Message, turnId?: string | null): void {
    if (!msg.id) return;
    this.fire('user_msg_added', msg, turnId);
  }

  /** Emit assistant_message_finalized at the done-event boundary. */
  assistantMsgFinalized(msg: Message, turnId?: string | null): void {
    if (!msg.id) return;
    this.fire('assistant_message_finalized', msg, turnId);
  }

  /** Emit tool_result_added at the tool-result boundary. */
  toolResultAdded(msg: Message, turnId?: string | null): void {
    if (!msg.id) return;
    this.fire('tool_result_added', msg, turnId);
  }

  /**
   * Emit a hook_invoked event for any ConfigHook triggered during this turn.
   * `event` is the structured HookInvokedEvent payload (carries name,
   * toolName, toolInput, etc.).
   */
  hookInvoked(turnId: string, hookEventId: string, payload: unknown): void {
    if (!hookEventId) return;
    const event: RolloutEvent = {
      type: 'hook_invoked',
      id: deterministicEventId(hookEventId, 'hook_invoked'),
      turnId,
      payload,
      createdAt: Date.now(),
    };
    this.fireEvent('hook_invoked', event, turnId);
  }

  /**
   * Append a rebase event for compaction / edit-resend. The rebase event is
   * the SOLE production persistence path for these operations — the old
   * `rewriteSession` mutation path is deprecated (kept only for test rollback
   * and emergency recovery).
   *
   * Pass `supersededUpToSeq = null` (the compaction form) to supersede ALL
   * raw messages preceding the rebase in the trace; survivors are matched
   * by id against `newMessages`. The subprocess has no reliable view of the
   * DB-assigned per-session seq, so numeric bounds are only correct for
   * callers that derive them from the main process (e.g. db-handlers).
   *
   * `newMessages` are Message objects that will replace every superseded
   * MessageEntry in the projection.
   */
  appendRebase(
    turnId: string,
    supersededUpToSeq: number | null,
    newMessages: Message[],
    createdAt: number = Date.now(),
    reason: 'compaction' | 'edit_resend' = 'compaction',
  ): void {
    // Convert agent-core Message[] → MessageEntry[] for the storage layer.
    // The db-bridge's journal:emit handler forwards the payload verbatim,
    // so the wire shape must match what MessageLog expects.
    const newEntries = this.toMessageEntries(newMessages, createdAt, turnId);
    const event = {
      type: 'rebase' as const,
      id: deterministicEventId(`${turnId}:${supersededUpToSeq ?? 'all'}`, 'rebase'),
      turnId,
      supersededUpToSeq,
      reason,
      newMessages: newEntries,
      createdAt,
    };
    this.fireEventRaw('rebase', event, turnId);
  }

  /**
   * Convert the agent-core Message[] into MessageEntry[] the storage layer
   * needs on the wire. Mirrors the conversion in
   * `electron/ipc/core-db-adapters.ts:ipcMessageToNewEvent` — kept local so
   * the journal does not depend on the electron-side adapter module.
   */
  private toMessageEntries(msgs: Message[], createdAt: number, turnId: string | null): MessageEntry[] {
    // Fallback ids MUST be deterministic for INSERT OR IGNORE dedup: a
    // boundary re-emitted after a crash/retry collapses into the original
    // row instead of forking a duplicate. Derived from the rebase's own
    // stable inputs (turnId + position + createdAt), never Date.now() at
    // conversion time.
    return msgs.map((m, i) => ({
      type: 'message' as const,
      id: m.id ?? `journal-rebase:${this.sessionId}:${turnId ?? 'anon'}:${i}:${createdAt}`,
      parentId: null,
      createdAt: m.timestamp ?? createdAt,
      message: ingestMessage(m, { index: i }),
    }));
  }

  // ─── Private helpers ───

  /**
   * Wait for every in-flight fire-and-forget emit to settle. The agent loop
   * never awaits individual emits (a slow write must not stall the stream),
   * but the turn-end `chat:db_persisted` ack MUST NOT be sent while emits
   * are still in flight — the renderer treats that ack as the signal to
   * reload durable rows, and a premature read would see a partial timeline.
   * Resolves even when individual emits failed (onError already reported).
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /** Register an emit promise so flush() can wait for it. */
  private trackPending(p: Promise<void>): void {
    const wrapped = p.finally(() => {
      this.pending.delete(wrapped);
    });
    this.pending.add(wrapped);
  }

  /**
   * Build a MessageEntry-shaped DTO for the journal emit. Routed through
   * `message:append`, so the flat field list must stay in sync with
   * `IpcMessageDTO` (electron/ipc/core-db-adapters.ts). The single
   * `JOURNAL_MESSAGE_FIELDS` key list below is the only place to update
   * when the persisted Message surface grows.
   */
  private fire(kind: string, msg: Message, turnId: string | null | undefined): void {
    const source = msg as unknown as Record<string, unknown>;
    const dto: Record<string, unknown> = {
      id: deterministicEventId(msg.id, kind),
      session_id: this.sessionId,
      // message:append journal discriminator (see db-bridge.ts)
      kind,
    };
    for (const field of JOURNAL_MESSAGE_FIELDS) {
      if (source[field] !== undefined) dto[field] = source[field];
    }
    // token_usage: prefer the top-level `tokenUsage` object (duya projection
    // field, survives ingestMessage via LEGACY_KNOWN_KEYS); fall back to the
    // legacy metadata string. The rollout entry's metadata is what the read
    // side (messageToIpcRow / ipcMessageToNewEvent) round-trips.
    const tokenUsageBlock = source.tokenUsage as Record<string, unknown> | string | undefined;
    if (tokenUsageBlock !== undefined) {
      dto.token_usage = typeof tokenUsageBlock === 'string' ? tokenUsageBlock : JSON.stringify(tokenUsageBlock);
    } else if (msg.metadata?.token_usage !== undefined) {
      dto.token_usage = msg.metadata.token_usage as string | undefined;
    }
    // Plan 486 §3.2: thread/fork metadata rides the journal emit so branched
    // messages stay fully durable in the rollout. The electron write path
    // (core-db-adapters PERSISTED_METADATA_KEYS) whitelists the key.
    const threadMeta = (msg.metadata as Record<string, unknown> | undefined)?.[THREAD_METADATA_KEY];
    if (threadMeta !== undefined) {
      dto.metadata = { [THREAD_METADATA_KEY]: threadMeta };
    }
    this.trackPending(
      messageDb
        .append(this.sessionId, [dto], turnId ?? null)
        .then((result) => {
          const r = result as { success?: boolean; reason?: string } | undefined;
          if (!r?.success) {
            this.onError(kind, new Error(`append returned ${JSON.stringify(result)}`));
          }
        })
        .catch((err: unknown) => {
          this.onError(kind, err);
        }),
    );
  }

  /**
   * Emit a RolloutEvent whose `newMessages` is already `MessageEntry[]`
   * (rebase path — the converter ran above). For hook_invoked the payload
   * field is unchanged. Pass-through IPC.
   *
   * Must route through `messageDb.emit` (→ `journal:emit`), NOT
   * `messageDb.append` (→ `message:append`). The `message:append` adapter
   * treats each entry as a fresh IpcMessageDTO and forces it through
   * `ingestMessage`, which discards the event's `type` discriminator and
   * collapses unknown shapes into `legacy_unknown_role` rows. Routing
   * rebase / hook_invoked events through emit preserves the discriminator
   * so MessageLog stores them as RolloutEvent rows. (Bug: an earlier
   * version called append here, producing silently-broken bot sessions.)
   */
  private fireEventRaw(kind: string, event: unknown, turnId: string | null | undefined): void {
    this.trackPending(
      messageDb
        .emit(this.sessionId, event, turnId ?? null)
        .then((result) => {
          const r = result as { success?: boolean; reason?: string } | undefined;
          if (!r?.success) {
            this.onError(kind, new Error(`emit returned ${JSON.stringify(result)}`));
          }
        })
        .catch((err: unknown) => {
          this.onError(kind, err);
        }),
    );
  }

  /** Emit a typed RolloutEvent (used by hook_invoked). */
  private fireEvent(kind: string, event: RolloutEvent, turnId: string | null | undefined): void {
    this.fireEventRaw(kind, event, turnId);
  }
}

/**
 * Deterministic event id: `${sourceId}:${eventKind}`. The source message id
 * is stable across retries of the same boundary (unlike a timestamp nonce),
 * which is what makes INSERT OR IGNORE dedup real: a boundary re-emitted
 * after a crash/retry collapses into the original row instead of forking a
 * duplicate. Different boundaries of the same source differ by kind; hook
 * invocations pass their unique hookEventId as sourceId.
 */
function deterministicEventId(sourceId: string | undefined, kind: string): string {
  return `journal:${sourceId ?? 'anon'}:${kind}`;
}
/**
 * Flat Message fields copied verbatim into the journal emit DTO. Must cover
 * every field `ipcMessageToNewEvent` reads from `IpcMessageDTO` — when a new
 * persisted Message field is added there, add it here too.
 */
const JOURNAL_MESSAGE_FIELDS: readonly string[] = [
  'role',
  'content',
  'timestamp',
  'seq_index',
  'msg_type',
  'tool_call_id',
  'tool_name',
  'tool_input',
  'thinking',
  'displayContent',
  'status',
  'duration_ms',
  'name',
  'parent_tool_call_id',
  'attachments',
  'viz_spec',
  'sub_agent_id',
  // Plan 489 P0.1: origin classifier — worker-side explicit tagging (e.g.
  // SendMessageTool's 'send_message') must survive the journal emit; absent
  // values are inferred at the IPC boundary (inferMessageSource).
  'source',
];
