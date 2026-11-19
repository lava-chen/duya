/**
 * pending.ts — the durable work index a restart has to be able to enumerate.
 *
 * The channel domain stores its evidence in plan A's tables and asks A's
 * `ProjectChannelStore` for every single-row operation. Boot recovery needs one
 * thing a per-row getter cannot answer: "what is still unfinished?".
 *
 * That question used to be answered here with raw SQL against A's tables, which
 * put the channel schema in two packages and made every column rename a
 * cross-package edit. The four queries now live on `ProjectChannelStore`; this
 * module is only the domain-facing projection of them, so the Host keeps one
 * narrow read seam and no knowledge of table shapes.
 *
 * Deliberately NOT here: a new table, a sweep, or a second state machine. A
 * migration number belongs to A, and a duplicate ledger would be a second
 * authority the first time it disagreed with the receipt it mirrors.
 */

import type { ProjectChannelStore } from '@duya/data';

export interface ProjectChannelQueuedInput {
  readonly sessionId: string;
  readonly requestId: string;
}

export interface ProjectChannelPendingIndex {
  /** Events persisted but never attached to an input: safe to resolve again. */
  listUnsubmittedInboundIds(limit?: number): string[];
  /** Deliveries that were mid-send when the previous process died. No receipt exists. */
  listSendingDeliveryIds(limit?: number): string[];
  /**
   * Inputs a drainer had claimed (stage `queued`) whose outcome was never
   * recorded. These are the "started or not, nobody knows" rows and are never
   * restarted automatically.
   */
  listQueuedInputs(limit?: number): ProjectChannelQueuedInput[];
  /**
   * Whether a reply delivery already exists for this inbound. The tool layer's
   * "did this external turn answer the message?" check reads this instead of
   * counting tool-name mentions, which a failed call would satisfy.
   */
  hasReplyDelivery(inboundId: string): boolean;
}

/** The read-only slice of the store this index needs. */
export type ProjectChannelPendingSource = Pick<
  ProjectChannelStore,
  'listUnsubmittedInboundIds' | 'listSendingDeliveryIds' | 'listQueuedInboundInputs' | 'hasReplyDelivery'
>;

export function createProjectChannelPendingIndex(
  channels: ProjectChannelPendingSource,
): ProjectChannelPendingIndex {
  return {
    listUnsubmittedInboundIds: (limit) => channels.listUnsubmittedInboundIds(limit),
    listSendingDeliveryIds: (limit) => channels.listSendingDeliveryIds(limit),
    listQueuedInputs: (limit) => channels.listQueuedInboundInputs(limit),
    hasReplyDelivery: (inboundId) => channels.hasReplyDelivery(inboundId),
  };
}
