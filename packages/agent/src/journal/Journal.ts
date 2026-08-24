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
  /**
   * Plan 441: monotonic counter of events emitted by this Journal instance.
   * The subprocess is the single writer for the session's rollout, so this
   * tracks the file seq for events the Journal itself produced (rebase +
   * message boundaries). Compaction rebase uses this counter as
   * `supersededUpToSeq` so the projection drops every prior raw message
   * up to the compaction point without needing an extra IPC to query the
   * main-process `message_index` row count.
   *
   * Reset to 0 on construction; the agent constructs a new Journal per
   * subprocess lifetime so the counter always starts at the session's
   * pre-existing-event count would have to be reconciled by the main
   // process at load time anyway (the rebase's projection is seq-based
   // on the FILE, not on this counter — see applyRebases comment).
   */
  private localSeqCounter = 0;

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
   * `newMessages` are MessageEntry objects that will replace every
   * MessageEntry with `seq <= supersededUpToSeq` in the projection.
   */
  appendRebase(
    turnId: string,
    supersededUpToSeq: number,
    newMessages: Message[],
    createdAt: number = Date.now(),
  ): void {
    // Convert agent-core Message[] → MessageEntry[] for the storage layer.
    // The db-bridge's journal:emit handler forwards the payload verbatim,
    // so the wire shape must match what MessageLog expects.
    const newEntries = this.toMessageEntries(newMessages);
    // The RolloutEvent union uses `Message[]` here for ergonomics, but the
    // wire format requires `MessageEntry[]`. Cast through `unknown` so the
    // caller-facing API stays agent-core-shaped while the IPC payload is
    // storage-shaped.
    const event = {
      type: 'rebase' as const,
      id: deterministicEventId(`${turnId}:${supersededUpToSeq}:${createdAt}`, 'rebase'),
      turnId,
      supersededUpToSeq,
      newMessages: newEntries,
      createdAt,
    };
    this.fireEventRaw('rebase', event, turnId);
  }

  /**
   * Plan 441: compaction convenience. Uses the journal's own seq counter as
   * the `supersededUpToSeq` bound so the projection drops every prior raw
   * message without requiring an IPC to query the main-process message
   * index. The counter is local to this subprocess — see the comment on
   * `localSeqCounter` for the rebase-vs-projection semantics.
   *
   * The user message id is used as the rebase id seed so the compaction is
   * deterministically named per-turn across retries (INSERT OR IGNORE on
   * duplicate compaction events).
   */
  appendCompactionRebase(
    turnId: string,
    newMessages: Message[],
    createdAt: number = Date.now(),
  ): void {
    this.appendRebase(turnId, this.localSeqCounter, newMessages, createdAt);
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
    this.localSeqCounter += 1;
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
    this.localSeqCounter += 1;
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
 * Deterministic event id: `${sourceId}:${eventKind}:${nonce}`. The source
 * message id is stable (MessageEntry.id is set on first push and never
 * changes) and the event kind disambiguates multiple emits from the same
 * boundary (e.g. the same assistant text re- and re-finalize paths). INSERT
 * OR IGNORE on the `message_index.id` primary key makes re-emits silent
 * no-ops; the nonce is appended to keep uniqueness when sourceId is
 * undefined (e.g. a hook invocation without a stable source id).
 */
function deterministicEventId(sourceId: string | undefined, kind: string): string {
  return `journal:${sourceId ?? 'anon'}:${kind}:${Date.now()}`;
}