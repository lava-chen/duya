/**
 * Versioned, transport-neutral mailbox contract. The local Host is the sole
 * database adapter; clients use these operations instead of opening SQLite.
 */

export type HostMailboxKind = 'queued' | 'followup' | 'background_notification' | 'agent_dm';
export type HostMailboxStatus = 'pending' | 'observed' | 'applied' | 'cancelled';
export type HostMailboxApplyMode =
  | 'promote_to_user_message'
  | 'runtime_instruction'
  | 'tool_guard'
  | 'permission_context'
  | 'interrupt_signal'
  | 'deferred_to_next_turn';
export type HostMailboxCheckpoint =
  | 'before_model_turn'
  | 'after_model_turn'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'before_file_write'
  | 'before_shell_command'
  | 'before_final_answer'
  | 'on_permission_request'
  | 'on_error_recovery';

export interface HostMailboxItem {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: HostMailboxKind;
  readonly status: HostMailboxStatus;
  readonly priority: number;
  readonly content: string;
  readonly attachments: readonly unknown[] | null;
  readonly source: string;
  readonly clientMsgId: string | null;
  readonly submittedRunId: string;
  readonly claimToken: string | null;
  readonly claimExpiresAt: number | null;
  readonly claimAttempts: number;
  readonly lastClaimError: string | null;
  readonly observedAt: number | null;
  readonly observedAtCheckpoint: string | null;
  readonly observedByRunId: string | null;
  readonly injectedRunId: string | null;
  readonly applyMode: HostMailboxApplyMode | null;
  readonly appliedAt: number | null;
  readonly appliedAtCheckpoint: string | null;
  readonly appliedSummary: string | null;
  readonly resultingEventId: string | null;
  readonly editLockedAt: number | null;
  readonly cancelledAt: number | null;
  readonly cancelledBy: string | null;
  readonly cancelReason: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface HostMailboxEnqueueInput {
  readonly id: string;
  readonly sessionId: string;
  readonly submittedRunId: string;
  readonly content: string;
  readonly kind: HostMailboxKind;
  readonly attachments?: readonly unknown[];
  readonly clientMsgId?: string | null;
  readonly source?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface HostMailboxEditInput {
  readonly content?: string;
  readonly kind?: HostMailboxKind;
}

export interface HostMailboxClaimBatchInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly checkpoint: HostMailboxCheckpoint;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly coalesceWindowMs?: number;
  readonly maxClaimAttempts?: number;
}

export interface HostMailboxClaimBatchResult {
  readonly rows: readonly HostMailboxItem[];
  readonly claimTokens: readonly string[];
}

export interface HostMailboxApplyInput {
  readonly id: string;
  readonly claimToken: string;
  readonly mode: HostMailboxApplyMode;
  readonly checkpoint: HostMailboxCheckpoint;
  readonly summary?: string;
  readonly resultingEventId?: string | null;
}

export interface HostMailboxCancelByAgentInput {
  readonly id: string;
  readonly claimToken: string;
  readonly reason: string;
}

export interface HostLocalMailboxApiV1 {
  getItem(id: string): Promise<HostMailboxItem | null>;
  getByClientMsgId(sessionId: string, clientMsgId: string): Promise<HostMailboxItem | null>;
  enqueue(input: HostMailboxEnqueueInput): Promise<HostMailboxItem>;
  edit(id: string, patch: HostMailboxEditInput): Promise<HostMailboxItem | null>;
  guide(id: string): Promise<HostMailboxItem | null>;
  promoteQueued(id: string): Promise<HostMailboxItem | null>;
  cancel(id: string, reason?: string): Promise<HostMailboxItem | null>;
  cancelByAgent(input: HostMailboxCancelByAgentInput): Promise<HostMailboxItem | null>;
  claimBatch(input: HostMailboxClaimBatchInput): Promise<HostMailboxClaimBatchResult>;
  apply(input: HostMailboxApplyInput): Promise<HostMailboxItem>;
  listMailboxItems(
    sessionId: string,
    options?: { readonly status?: readonly HostMailboxStatus[]; readonly limit?: number },
  ): Promise<readonly HostMailboxItem[]>;
  listMailboxItemsForSession(sessionId: string): Promise<readonly HostMailboxItem[]>;
}
