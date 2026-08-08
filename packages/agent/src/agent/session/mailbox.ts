/**
 * mailbox.ts - MailboxClaimer
 *
 * Encapsulates mailbox row claiming at a turn checkpoint (Plan 334 Phase 4+5).
 * Lifts the semantics of `DuyaAgent._claimMailboxAtCheckpoint` into a standalone
 * store: it claims a batch of pending rows via `mailboxDb.claimBatch`, applies
 * each claimed row, and adapts the payload into provider messages pushed onto
 * the caller-supplied `messages` array.
 *
 * Contract:
 * - Transient runtime context produced here (mailbox guidance and background
 *   notifications) is pushed to the working `messages` array only; it is never
 *   appended to the durable timeline (the host's persistence filter drops it).
 * - Guidance rows collapse into one `<runtime-user-guidance>` block; background
 *   notification rows keep their raw `<task-notification>` XML envelope.
 */

import type { Message } from '../../types.js';
import { mailboxDb } from '../../ipc/db-client.js';
import type { MailboxRow } from '../../session/db.js';
import {
  adaptBackgroundNotification,
  adaptMailboxRows,
  projectRuntimeContextToProviderMessage,
} from '../../message/runtime-context-adapters.js';
import {
  chooseMailboxApplyMode,
  type RuntimeMailboxClaim,
  type RuntimeMailboxDecision,
} from '../utils/agent-helpers.js';
import { logger } from '../../utils/logger.js';

/** Checkpoints at which the mailbox may be claimed. */
export type MailboxCheckpoint = 'before_model_turn' | 'before_final_answer';

/** Input describing where and how to claim the mailbox. */
export interface MailboxClaimInput {
  readonly runId: string;
  /** Working message array the adapted provider messages are pushed onto. */
  readonly messages: Message[];
  /** Current sequence index used by the runtime-context adapters. */
  readonly seqIndex: number;
  readonly checkpoint: MailboxCheckpoint;
}

/**
 * Claims mailbox rows for a session at a given checkpoint.
 */
export class MailboxClaimer {
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Claim pending mailbox rows and absorb them into the working `messages`
   * array as runtime context. Returns a {@link RuntimeMailboxDecision} signalling
   * the outcome to the caller. Never throws for claim failures — it degrades to
   * `{ action: 'continue', absorbed: false }`.
   */
  async claim(input: MailboxClaimInput): Promise<RuntimeMailboxDecision> {
    const { runId, messages, seqIndex, checkpoint } = input;

    let claim: RuntimeMailboxClaim;
    try {
      claim = (await mailboxDb.claimBatch({
        sessionId: this.sessionId,
        runId,
        checkpoint,
        limit: 10,
      })) as RuntimeMailboxClaim;
    } catch (err) {
      logger.warn(
        `[AgentMailbox] ${checkpoint} claim failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { action: 'continue', absorbed: false };
    }

    if (!claim.rows.length) {
      return { action: 'continue', absorbed: false };
    }

    const applyRow = async (row: MailboxRow, index: number, summary: string): Promise<void> => {
      const claimToken = claim.claimTokens[index];
      if (!claimToken) return;
      await mailboxDb.apply({
        id: row.id,
        claimToken,
        mode: chooseMailboxApplyMode(row),
        checkpoint,
        summary,
      });
    };

    const usableRows = claim.rows.filter((row) => row.content.trim().length > 0);
    if (!usableRows.length) {
      return { action: 'continue', absorbed: false };
    }

    // Segregate terminal background-task notifications from user guidance rows
    // so each follows its own adapter.
    const guidanceRows = usableRows.filter((row) => row.kind !== 'background_notification');
    const backgroundNotificationRows = usableRows.filter((row) => row.kind === 'background_notification');

    for (const row of usableRows) {
      await applyRow(row, claim.rows.indexOf(row), 'absorbed as runtime instruction before model turn');
    }

    for (const row of backgroundNotificationRows) {
      const ctx = adaptBackgroundNotification(row, { seqIndex });
      const projected = projectRuntimeContextToProviderMessage(ctx);
      if (projected) messages.push(projected);
    }

    if (guidanceRows.length > 0) {
      // Align claim tokens with the guidance (non-empty) rows.
      const guidanceTokens = guidanceRows.map((row) => claim.claimTokens[claim.rows.indexOf(row)]);
      const adapted = adaptMailboxRows(guidanceRows, guidanceTokens, { seqIndex });
      for (const ctx of adapted) {
        const projected = projectRuntimeContextToProviderMessage(ctx);
        if (projected) messages.push(projected);
      }
    }

    logger.info(`[AgentMailbox] absorbed ${usableRows.length} row(s) at ${checkpoint}`);
    return { action: 'continue', absorbed: true };
  }
}