/**
 * Re-export the rollout event types that the agent-core Journal emits.
 * Kept in a sub-module so `Journal.ts` does not pull the Electron
 * message-log types into agent-core (it imports them only via db-client).
 *
 * The RolloutEvent union here is the agent-core subset — rebase events and
 * hook events are emitted directly without going through the @duya/agent
 * Message shape. The Electron-side storage layer (message-log.ts) holds
 * the canonical RolloutLine union and is responsible for projecting
 * these events into the JSONL rollout file.
 */

import type { Message } from '../message/index.js';

/**
 * Agent-core mirror of the Electron-side RolloutEvent union. Only the
 * variants the Journal emits are represented here; the storage layer's
 * canonical definition lives in `electron/db/core/rollout-events.ts`.
 *
 * Note: `newMessages` is `Message[]` here (the agent's representation),
 * converted to `MessageEntry[]` at the IPC boundary by `Journal.appendRebase`.
 *
 * Variants:
 *   - `rebase` — supersedes prior MessageEntries (compaction / edit-resend).
 *   - `hook_invoked` — a ConfigHook fired during this turn.
 */
export type RolloutEvent =
  | {
      type: 'rebase';
      id: string;
      turnId: string;
      supersededUpToSeq: number;
      /**
       * Why this rebase was emitted. Drives rotation in the storage layer:
       * `compaction` rebases rotate the rollout file (Plan 506/493),
       * `edit_resend` rebases are inline mutations and do not. Defaults to
       * `compaction` when omitted — historical rebase events from before
       * this field existed were all compaction form (Plan 441).
       */
      reason?: 'compaction' | 'edit_resend';
      newMessages: Message[];
      createdAt: number;
    }
  | {
      type: 'hook_invoked';
      id: string;
      turnId: string;
      /** HookInvokedEvent-shaped payload (caller-defined). */
      payload: unknown;
      createdAt: number;
    };