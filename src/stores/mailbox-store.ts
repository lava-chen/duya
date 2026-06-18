/**
 * mailbox-store.ts - Zustand store for AgentMailbox (Plan 202 — PR1)
 *
 * Manages mailbox entries on the renderer side with optimistic updates
 * and event-based reconciliation from the MailboxBroadcaster.
 *
 * PR1 scope: send / edit / cancel / list with optimistic local state.
 * PR1 does NOT handle observed/applied events (those come in PR2).
 */

import { create } from 'zustand';

// =============================================================================
// Types (mirrors agent_mailbox schema, camelCase for frontend)
// =============================================================================

export type MailboxKind = 'followup' | 'correction' | 'constraint' | 'stop' | 'abort_and_replace';
export type MailboxStatus = 'pending' | 'observed' | 'applied' | 'cancelled';

export interface MailboxRow {
  id: string;
  sessionId: string;
  submittedDuringRunId: string;
  content: string;
  kind: MailboxKind;
  status: MailboxStatus;
  priority: number;
  constraintsJson: string | null;
  attachmentsJson: string | null;
  source: string;
  clientMsgId: string | null;
  createdAt: number;
  claimToken: string | null;
  claimExpiresAt: number | null;
  observedAt: number | null;
  observedAtCheckpoint: string | null;
  observedByRunId: string | null;
  claimAttempts: number;
  lastClaimError: string | null;
  editLockedAt: number | null;
  applyMode: string | null;
  appliedAt: number | null;
  appliedAtCheckpoint: string | null;
  appliedSummary: string | null;
  resultingUserMsgId: string | null;
  failureReason: string | null;
  editHistoryJson: string | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancelReason: string | null;
}

export type MailboxBroadcastEventType =
  | 'mail:created'
  | 'mail:edited'
  | 'mail:cancelled'
  | 'mail:observed'
  | 'mail:applied';

export interface MailboxBroadcastEvent {
  type: MailboxBroadcastEventType;
  row: Record<string, unknown>;
  prevContent?: string;
  reason?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert snake_case DB row to camelCase MailboxRow */
function dbRowToMailboxRow(row: Record<string, unknown>): MailboxRow {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    submittedDuringRunId: row.submitted_during_run_id as string,
    content: row.content as string,
    kind: row.kind as MailboxKind,
    status: row.status as MailboxStatus,
    priority: row.priority as number,
    constraintsJson: row.constraints_json as string | null,
    attachmentsJson: row.attachments_json as string | null,
    source: row.source as string,
    clientMsgId: row.client_msg_id as string | null,
    createdAt: row.created_at as number,
    claimToken: row.claim_token as string | null,
    claimExpiresAt: row.claim_expires_at as number | null,
    observedAt: row.observed_at as number | null,
    observedAtCheckpoint: row.observed_at_checkpoint as string | null,
    observedByRunId: row.observed_by_run_id as string | null,
    claimAttempts: row.claim_attempts as number,
    lastClaimError: row.last_claim_error as string | null,
    editLockedAt: row.edit_locked_at as number | null,
    applyMode: row.apply_mode as string | null,
    appliedAt: row.applied_at as number | null,
    appliedAtCheckpoint: row.applied_at_checkpoint as string | null,
    appliedSummary: row.applied_summary as string | null,
    resultingUserMsgId: row.resulting_user_msg_id as string | null,
    failureReason: row.failure_reason as string | null,
    editHistoryJson: row.edit_history_json as string | null,
    cancelledAt: row.cancelled_at as number | null,
    cancelledBy: row.cancelled_by as string | null,
    cancelReason: row.cancel_reason as string | null,
  };
}

// =============================================================================
// Store
// =============================================================================

interface MailboxState {
  /** Map of sessionId → Map of rowId → MailboxRow */
  bySession: Map<string, Map<string, MailboxRow>>;

  // Selectors
  getBySession: (sessionId: string, filter?: { status?: MailboxStatus[] }) => MailboxRow[];
  count: (sessionId: string, status: MailboxStatus) => number;

  // Actions
  send: (params: {
    sessionId: string;
    content: string;
    kind: MailboxKind;
    submittedDuringRunId: string;
    attachments?: unknown[];
    source?: string;
    constraintsJson?: string;
  }) => Promise<MailboxRow | null>;
  edit: (id: string, patch: { content?: string; kind?: MailboxKind }) => Promise<void>;
  guide: (id: string) => Promise<void>;
  cancel: (id: string, reason?: string) => Promise<void>;
  list: (sessionId: string, opts?: { status?: MailboxStatus[]; limit?: number }) => Promise<void>;

  // Event reconciliation (called by mailbox event listener)
  applyEvent: (event: MailboxBroadcastEvent) => void;

  // Internal
  _upsertRow: (row: MailboxRow) => void;
  _removeRow: (sessionId: string, id: string) => void;
}

export const useMailboxStore = create<MailboxState>()((set, get) => ({
  bySession: new Map(),

  getBySession: (sessionId, filter) => {
    const sessionMap = get().bySession.get(sessionId);
    if (!sessionMap) return [];
    const rows = Array.from(sessionMap.values());
    if (filter?.status && filter.status.length > 0) {
      return rows.filter(r => filter.status!.includes(r.status));
    }
    return rows;
  },

  count: (sessionId, status) => {
    const rows = get().getBySession(sessionId, { status: [status] });
    return rows.length;
  },

  send: async (params) => {
    const clientMsgId = crypto.randomUUID();
    const electronAPI = window.electronAPI;

    if (!electronAPI?.mailbox) {
      console.error('[MailboxStore] electronAPI.mailbox not available');
      return null;
    }

    // Optimistic: create local row immediately
    const now = Date.now();
    const optimisticId = `optimistic-${clientMsgId}`;
    const optimisticRow: MailboxRow = {
      id: optimisticId,
      sessionId: params.sessionId,
      submittedDuringRunId: params.submittedDuringRunId,
      content: params.content,
      kind: params.kind,
      status: 'pending',
      priority: 100,
      constraintsJson: params.constraintsJson ?? null,
      attachmentsJson: params.attachments ? JSON.stringify(params.attachments) : null,
      source: params.source ?? 'ui',
      clientMsgId,
      createdAt: now,
      claimToken: null,
      claimExpiresAt: null,
      observedAt: null,
      observedAtCheckpoint: null,
      observedByRunId: null,
      claimAttempts: 0,
      lastClaimError: null,
      editLockedAt: null,
      applyMode: null,
      appliedAt: null,
      appliedAtCheckpoint: null,
      appliedSummary: null,
      resultingUserMsgId: null,
      failureReason: null,
      editHistoryJson: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
    };

    // Add optimistic row immediately
    get()._upsertRow(optimisticRow);

    try {
      const result = await electronAPI.mailbox.send({
        sessionId: params.sessionId,
        content: params.content,
        kind: params.kind,
        submittedDuringRunId: params.submittedDuringRunId,
        attachments: params.attachments,
        clientMsgId,
        source: params.source,
        constraintsJson: params.constraintsJson,
      });

      if (result) {
        const row = dbRowToMailboxRow(result as Record<string, unknown>);
        // Replace optimistic row with server row
        set(state => {
          const newBySession = new Map(state.bySession);
          const sessionMap = new Map(newBySession.get(params.sessionId) ?? new Map());
          sessionMap.delete(optimisticId);
          sessionMap.set(row.id, row);
          newBySession.set(params.sessionId, sessionMap);
          return { bySession: newBySession };
        });
        return row;
      }

      return null;
    } catch (error) {
      console.error('[MailboxStore] send failed:', error);
      // Keep optimistic row but mark as failed in UI
      return optimisticRow;
    }
  },

  edit: async (id, patch) => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.mailbox) return;

    try {
      const result = await electronAPI.mailbox.edit(id, patch);
      if (result) {
        const row = dbRowToMailboxRow(result as Record<string, unknown>);
        get()._upsertRow(row);
      }
    } catch (error) {
      console.error('[MailboxStore] edit failed:', error);
    }
  },

  guide: async (id) => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.mailbox?.guide) return;

    const existing = Array.from(get().bySession.values())
      .map(sessionMap => sessionMap.get(id))
      .find((row): row is MailboxRow => Boolean(row));

    if (existing && existing.status === 'pending') {
      get()._upsertRow({ ...existing, source: 'ui:guide' });
    }

    try {
      const result = await electronAPI.mailbox.guide(id);
      if (result) {
        const row = dbRowToMailboxRow(result as Record<string, unknown>);
        get()._upsertRow(row);
      }
    } catch (error) {
      if (existing) {
        get()._upsertRow(existing);
      }
      console.error('[MailboxStore] guide failed:', error);
    }
  },

  cancel: async (id, reason) => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.mailbox) return;

    try {
      const result = await electronAPI.mailbox.cancel(id, reason);
      if (result) {
        const row = dbRowToMailboxRow(result as Record<string, unknown>);
        get()._removeRow(row.sessionId, row.id);
      }
    } catch (error) {
      console.error('[MailboxStore] cancel failed:', error);
    }
  },

  list: async (sessionId, opts) => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.mailbox) return;

    try {
      const rows = await electronAPI.mailbox.list(sessionId, opts);
      if (rows && Array.isArray(rows)) {
        set(state => {
          const newBySession = new Map(state.bySession);
          const sessionMap = new Map<string, MailboxRow>();
          for (const raw of rows) {
            const row = dbRowToMailboxRow(raw as Record<string, unknown>);
            sessionMap.set(row.id, row);
          }
          newBySession.set(sessionId, sessionMap);
          return { bySession: newBySession };
        });
      }
    } catch (error) {
      console.error('[MailboxStore] list failed:', error);
    }
  },

  applyEvent: (event) => {
    if (!event?.row) return;

    const row = dbRowToMailboxRow(event.row);

    switch (event.type) {
      case 'mail:created':
        // Server row arrived — replace any optimistic row with matching clientMsgId
        set(state => {
          const newBySession = new Map(state.bySession);
          const sessionMap = new Map(newBySession.get(row.sessionId) ?? new Map());

          // Remove any optimistic rows with same clientMsgId
          if (row.clientMsgId) {
            for (const [id, existing] of sessionMap) {
              if (id.startsWith('optimistic-') && existing.clientMsgId === row.clientMsgId) {
                sessionMap.delete(id);
              }
            }
          }

          sessionMap.set(row.id, row);
          newBySession.set(row.sessionId, sessionMap);
          return { bySession: newBySession };
        });
        break;

      case 'mail:edited':
      case 'mail:observed':
      case 'mail:applied':
        get()._upsertRow(row);
        break;

      case 'mail:cancelled':
        get()._removeRow(row.sessionId, row.id);
        break;
    }
  },

  _upsertRow: (row) => {
    set(state => {
      const newBySession = new Map(state.bySession);
      const sessionMap = new Map(newBySession.get(row.sessionId) ?? new Map());
      sessionMap.set(row.id, row);
      newBySession.set(row.sessionId, sessionMap);
      return { bySession: newBySession };
    });
  },

  _removeRow: (sessionId, id) => {
    set(state => {
      const newBySession = new Map(state.bySession);
      const sessionMap = new Map(newBySession.get(sessionId));
      if (sessionMap) {
        sessionMap.delete(id);
        newBySession.set(sessionId, sessionMap);
      }
      return { bySession: newBySession };
    });
  },
}));

// =============================================================================
// Mailbox event listener setup
// =============================================================================

let eventListenerRegistered = false;

/**
 * Initialize mailbox event listener.
 * Call once at app startup. Listens for MailboxBroadcaster events
 * from the main process and reconciles with the store.
 */
export function initMailboxEventListener(): () => void {
  if (eventListenerRegistered) return () => {};

  const electronAPI = window.electronAPI;
  if (!electronAPI?.mailbox?.onEvent) {
    return () => {};
  }

  eventListenerRegistered = true;
  const unsubscribe = electronAPI.mailbox.onEvent((event) => {
    useMailboxStore.getState().applyEvent(event as MailboxBroadcastEvent);
  });

  return () => {
    unsubscribe?.();
    eventListenerRegistered = false;
  };
}
