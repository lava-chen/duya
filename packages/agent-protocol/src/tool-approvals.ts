/**
 * Durable tool-approval records and decisions owned by Duya Host.
 *
 * These names retain the persisted row shape during the IPC migration because
 * the renderer and worker bridge already consume it. New clients should use
 * the typed API rather than opening SQLite directly.
 */
export type HostToolApprovalStatus = 'pending' | 'approved' | 'consumed' | 'denied';
export type HostToolApprovalDecision = 'allow' | 'always' | 'deny';
export type HostToolApprovalScopeType = 'bot' | 'session';

export interface HostToolApprovalInput {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly scopeType: HostToolApprovalScopeType;
  readonly scopeId: string;
  readonly toolName: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
}

export interface HostToolApproval {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly scope_type: HostToolApprovalScopeType;
  readonly scope_id: string;
  readonly tool_name: string;
  readonly tool_input_json: string | null;
  readonly input_hash: string;
  readonly status: HostToolApprovalStatus;
  readonly decision: HostToolApprovalDecision | null;
  readonly decided_at: number | null;
  readonly created_at: number;
}

export interface HostToolApprovalResolution {
  readonly row: HostToolApproval;
  readonly claimed: boolean;
}

/** Async persistence boundary for approval cards, one-shot permits and grants. */
export interface HostToolApprovalApiV1 {
  createToolApproval(input: HostToolApprovalInput): Promise<HostToolApproval>;
  getToolApproval(id: string): Promise<HostToolApproval | null>;
  listToolApprovalsBySession(sessionId: string): Promise<readonly HostToolApproval[]>;
  resolveToolApproval(
    id: string,
    decision: HostToolApprovalDecision,
  ): Promise<HostToolApprovalResolution | null>;
  consumeApprovedToolApproval(input: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly inputHash: string;
  }): Promise<boolean>;
  consumeToolApprovalById(id: string): Promise<HostToolApproval | null>;
  upsertToolApprovalRule(input: {
    readonly scopeType: HostToolApprovalScopeType;
    readonly scopeId: string;
    readonly toolName: string;
  }): Promise<void>;
  listToolApprovalRules(input: {
    readonly scopeType: HostToolApprovalScopeType;
    readonly scopeId: string;
  }): Promise<readonly string[]>;
}
