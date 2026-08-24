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
   * the SOLE persistence path for these operations going forward — the old
   * `rewriteSession` mutation path will be removed in Phase 4.
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
  ): void {
    // Convert agent-core Message[] → MessageEntry[] for the storage layer.
    // The db-bridge's journal:emit handler forwards the payload verbatim,
    // so the wire shape must match what MessageLog expects.
    const newEntries = this.toMessageEntries(newMessages);
    const event = {
      type: 'rebase' as const,
      id: deterministicEventId(`${turnId}:${supersededUpToSeq ?? 'all'}`, 'rebase'),
      turnId,
      supersededUpToSeq,
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
  private toMessageEntries(Msgs: Message[]): MessageEntry[] {
    return Msgs.map((m, i) => ({
      type: 'message' as const,
      id: m.id ?? `journal-rebase-${i}-${Date.now()}`,
      parentId: null,
      createdAt: m.timestamp ?? Date.now(),
      message: ingestMessage(m, { index: i }),
    }));
  }

  // ─── Private helpers ───

  /**
   * Build a MessageEntry-shaped DTO for the journal emit. The db-bridge
   * extension (journal:emit) recognises the `kind` discriminator and routes
   * to the right wrapper. For now we reuse `message:append` with a wrapper
   * DTO whose `kind` field carries the event type — see db-bridge.ts.
   */
  private fire(kind: string, msg: Message, turnId: string | null | undefined): void {
    const dto = {
      id: deterministicEventId(msg.id, kind),
      session_id: this.sessionId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp ?? Date.now(),
      // journal:emit discriminator
      kind,
      seq_index: msg.seq_index,
      msg_type: msg.msg_type,
      tool_call_id: msg.tool_call_id,
      tool_name: msg.tool_name,
      tool_input: msg.tool_input,
      thinking: msg.thinking,
      displayContent: msg.displayContent,
      status: msg.status,
      duration_ms: msg.duration_ms,
      name: msg.name,
      parent_tool_call_id: msg.parent_tool_call_id,
      attachments: msg.attachments,
      viz_spec: msg.viz_spec,
      sub_agent_id: msg.sub_agent_id,
      token_usage: msg.metadata?.token_usage as string | undefined,
    };
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
      });
  }

  /**
   * Emit a RolloutEvent whose `newMessages` is already `MessageEntry[]`
   * (rebase path — the converter ran above). For hook_invoked the payload
   * field is unchanged. Pass-through IPC.
   */
  private fireEventRaw(kind: string, event: unknown, turnId: string | null | undefined): void {
    messageDb
      .append(this.sessionId, [event], turnId ?? null)
      .then((result) => {
        const r = result as { success?: boolean; reason?: string } | undefined;
        if (!r?.success) {
          this.onError(kind, new Error(`append returned ${JSON.stringify(result)}`));
        }
      })
      .catch((err: unknown) => {
        this.onError(kind, err);
      });
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