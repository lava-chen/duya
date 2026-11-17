/**
 * pending.ts — the durable work index a restart has to be able to enumerate.
 *
 * The channel domain stores its evidence in the tables plan A owns, and asks A's
 * `ProjectChannelStore` for every single-row operation. Boot recovery needs one
 * thing a per-row getter cannot answer: "what is still unfinished?". This module
 * is that question, expressed as three read-only queries.
 *
 * Deliberately NOT here: a new table, a sweep, or a second state machine. A
 * migration number belongs to A, and a duplicate ledger would be a second
 * authority the first time it disagreed with the receipt it mirrors.
 */

/** The slice of the SQLite handle these queries need. */
export interface ProjectChannelQueryDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

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

const DEFAULT_LIMIT = 200;

function bounded(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000) : DEFAULT_LIMIT;
}

export function createProjectChannelPendingIndex(
  db: ProjectChannelQueryDatabase,
): ProjectChannelPendingIndex {
  return {
    listUnsubmittedInboundIds(limit) {
      const rows = db.prepare(
        `SELECT inbound_id FROM project_channel_inbounds
          WHERE input_id IS NULL
          ORDER BY created_at, inbound_id
          LIMIT ?`,
      ).all(bounded(limit)) as Array<{ inbound_id: string }>;
      return rows.map((row) => row.inbound_id);
    },

    listSendingDeliveryIds(limit) {
      const rows = db.prepare(
        `SELECT delivery_id FROM project_channel_deliveries
          WHERE status = 'sending'
          ORDER BY created_at, delivery_id
          LIMIT ?`,
      ).all(bounded(limit)) as Array<{ delivery_id: string }>;
      return rows.map((row) => row.delivery_id);
    },

    hasReplyDelivery(inboundId) {
      const rows = db.prepare(
        `SELECT delivery_id FROM project_channel_deliveries
          WHERE reply_to_inbound_id = ? AND status IN ('queued','sending','sent')
          LIMIT 1`,
      ).all(inboundId) as Array<{ delivery_id: string }>;
      return rows.length > 0;
    },

    listQueuedInputs(limit) {
      const rows = db.prepare(
        `SELECT i.target_session_id AS session_id, i.inbound_id AS request_id
           FROM project_channel_inbounds i
           JOIN session_inputs s
             ON s.session_id = i.target_session_id AND s.request_id = i.inbound_id
          WHERE s.stage = 'queued' AND i.input_id IS NOT NULL
          ORDER BY i.created_at, i.inbound_id
          LIMIT ?`,
      ).all(bounded(limit)) as Array<{ session_id: string; request_id: string }>;
      return rows.map((row) => ({ sessionId: row.session_id, requestId: row.request_id }));
    },
  };
}
