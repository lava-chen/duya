/**
 * core-db-adapters.ts — DTO adapter layer between the legacy IPC flat-row
 * shapes and the core store's CoreSession types (session/task/permission/
 * mailbox domains).
 *
 * The flat-message DTO ↔ timeline mapping now lives in
 * `@duya/host/ipc-message-adapters` (plan 12 gate 1: the Host worker db
 * bridge must convert identically) and is re-exported below.
 *
 * Write direction (IPC → core store):
 *   `ipcSessionToCoreCreate` / `ipcSessionToUpdate` — flat session DTO → core input
 *
 * Read direction (core store → IPC):
 *   `coreSessionToIpcRow` — CoreSession + extensions → old SessionRow shape
 *
 * See plan 328 decision 2 for the field-by-field mapping contract.
 */

import type { HostPermissionRequest, HostMailboxItem } from '@duya/agent-protocol';
import type {
  SessionCreateInput,
  SessionPatch,
  CoreTask,
  TaskCreateInput,
  TaskUpdateInput,
  PermissionCreateInput,
  PermissionResolveInput,
  MailboxItem,
} from '../db/core';

// ─── Session adapters ───

/**
 * Extension keys stored in `sessions.extensions` that map to top-level
 * columns in the old `chat_sessions` table.
 */
const SESSION_EXTENSION_KEYS = [
  'system_prompt',
  'conductor_mode_enabled',
  'conductor_canvas_id',
  'context_summary',
  'context_summary_updated_at',
  'plan_mode_enabled',
  'goal_mode_enabled',
  'source',
] as const;

/**
 * Map an IPC session create payload to SessionCreateInput.
 * `permissionMode` is resolved by the caller (via resolvePermissionProfile)
 * before calling this function — the adapter does not do business logic.
 *
 * Old `parent_id` / `parent_session_id` are merged into `parentSessionId`.
 * Old `draft_message` → `draft`. Old `permission_profile` → `permissionMode`.
 * Extension-bound fields (system_prompt, conductor_*, etc.) go to `extensions`.
 */
export function ipcSessionToCoreCreate(
  data: Record<string, unknown>,
  permissionMode: string,
): SessionCreateInput {
  const parentSessionId =
    (data.parent_session_id as string | undefined) ?? (data.parent_id as string | undefined) ?? null;

  const extensions: Record<string, unknown> = {};
  for (const key of SESSION_EXTENSION_KEYS) {
    if (data[key] !== undefined) {
      extensions[key] = data[key];
    }
  }

  return {
    id: data.id as string,
    title: data.title as string | undefined,
    workingDirectory: data.working_directory as string | undefined,
    projectName: data.project_name as string | undefined,
    status: data.status as string | undefined,
    model: data.model as string | undefined,
    providerId: data.provider_id as string | undefined,
    mode: data.mode as string | undefined,
    permissionMode,
    agentProfileId: (data.agent_profile_id as string | null | undefined) ?? null,
    parentSessionId,
    agentType: data.agent_type as string | undefined,
    agentName: data.agent_name as string | undefined,
    draft: (data.draft_message as string | null | undefined) ?? null,
    extensions,
    createdAt: data.created_at as number | undefined,
    updatedAt: data.updated_at as number | undefined,
  };
}

/**
 * Map an IPC session update payload to SessionPatch.
 * Only fields present in `data` are included in the patch.
 * Extension-bound fields are NOT handled here — callers use setExtension
 * for those (e.g. set_conductor_mode).
 */
export function ipcSessionToUpdate(data: Record<string, unknown>): SessionPatch {
  const patch: SessionPatch = {};
  if (data.title !== undefined) patch.title = data.title as string;
  if (data.working_directory !== undefined) patch.workingDirectory = data.working_directory as string;
  if (data.project_name !== undefined) patch.projectName = data.project_name as string;
  if (data.status !== undefined) patch.status = data.status as string;
  if (data.model !== undefined) patch.model = data.model as string;
  if (data.provider_id !== undefined) patch.providerId = data.provider_id as string;
  if (data.mode !== undefined) patch.mode = data.mode as string;
  if (data.permission_profile !== undefined) patch.permissionMode = data.permission_profile as string;
  if (data.parent_id !== undefined) patch.parentSessionId = data.parent_id as string | null;
  if (data.agent_profile_id !== undefined) patch.agentProfileId = data.agent_profile_id as string | null;
  if (data.agent_type !== undefined) patch.agentType = data.agent_type as string;
  if (data.agent_name !== undefined) patch.agentName = data.agent_name as string;
  return patch;
}

/**
 * `coreSessionToIpcRow` moved to `@duya/host/ipc-row-adapters` (plan 12
 * gate 1: the Host worker db bridge emits the same legacy row shape).
 */
export { coreSessionToIpcRow } from '@duya/host/ipc-row-adapters';


// ─── Message adapters (Host-owned single definition) ───

/**
 * The flat-message DTO ↔ timeline mapping moved to the Host package so the
 * Host worker db bridge and this Desktop bridge convert identically
 * (plan 12 gate 1). Re-exported here for every Desktop consumer.
 */
export {
  type MessageRow,
  serializeMessageContent,
  serializeDisplayContent,
  inferMessageSource,
  __test__inferMessageSource,
  ipcMessageToNewEvent,
  storedEventToIpcMessage,
  newEventToIpcMessage,
  storedEventsToIpcMessages,
  hostMessageItemsToIpcMessages,
} from '@duya/host/ipc-message-adapters';

// ─── Task adapters ───

/**
 * Core-task-store adapters (db-handlers path, `CoreTask` from the Desktop
 * core DB) stay here; the Host-task-contract adapters moved to
 * `@duya/host/ipc-row-adapters` and are re-exported below.
 */
export function ipcTaskToCoreCreate(data: {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  status?: string;
  active_form?: string | null;
  owner?: string | null;
}): TaskCreateInput {
  return {
    id: data.id,
    sessionId: data.session_id,
    subject: data.subject,
    description: data.description,
    status: data.status ?? 'pending',
    activeForm: data.active_form ?? null,
    owner: data.owner ?? null,
  };
}

export function ipcTaskToUpdate(data: Record<string, unknown>): TaskUpdateInput {
  const patch: TaskUpdateInput = {};
  if (data.subject !== undefined) patch.subject = data.subject as string;
  if (data.description !== undefined) patch.description = data.description as string;
  if (data.status !== undefined) patch.status = data.status as string;
  if (data.active_form !== undefined) patch.activeForm = data.active_form as string | null;
  if (data.owner !== undefined) patch.owner = data.owner as string | null;
  if (data.blocks !== undefined) patch.blocks = data.blocks as string[];
  if (data.blocked_by !== undefined) patch.blockedBy = data.blocked_by as string[];
  if (data.metadata !== undefined) patch.metadata = data.metadata as Record<string, unknown>;
  return patch;
}

export function coreTaskToIpcRow(task: CoreTask): Record<string, unknown> {
  return {
    id: task.id,
    session_id: task.sessionId,
    subject: task.subject,
    description: task.description,
    status: task.status,
    active_form: task.activeForm,
    owner: task.owner,
    blocks: JSON.stringify(task.blocks),
    blocked_by: JSON.stringify(task.blockedBy),
    metadata: JSON.stringify(task.metadata),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

export { ipcTaskToHostCreate } from '@duya/host/ipc-row-adapters';

export { ipcTaskToHostUpdate } from '@duya/host/ipc-row-adapters';

export { hostTaskToIpcRow } from '@duya/host/ipc-row-adapters';

// ─── Goal adapters (Plan 331 Phase 2) ───

/**
 * Goal/task row adapters moved to `@duya/host/ipc-row-adapters` (plan 12
 * gate 1) — re-exported for the Desktop bridge and db-handlers.
 */
export { coreGoalToIpcRow } from '@duya/host/ipc-row-adapters';

// ─── Permission adapters ───

/**
 * Map an IPC permission create payload to PermissionCreateInput.
 */
export function ipcPermissionToCoreCreate(data: {
  id: string;
  sessionId?: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}): PermissionCreateInput {
  return {
    id: data.id,
    sessionId: data.sessionId ?? null,
    toolName: data.toolName,
    toolInput: data.toolInput ?? null,
  };
}

/**
 * Map a PermissionRequest back to the old `permission_requests` row shape
 * (snake_case). JSON fields are re-serialized to match `SELECT *`.
 */
export function corePermissionToIpcRow(perm: HostPermissionRequest): Record<string, unknown> {
  return {
    id: perm.id,
    session_id: perm.sessionId,
    tool_name: perm.toolName,
    tool_input: perm.toolInput ? JSON.stringify(perm.toolInput) : null,
    status: perm.status,
    decision: perm.decision,
    message: perm.message,
    updated_permissions: perm.updatedPermissions ? JSON.stringify(perm.updatedPermissions) : null,
    updated_input: perm.updatedInput ? JSON.stringify(perm.updatedInput) : null,
    created_at: perm.createdAt,
    resolved_at: perm.resolvedAt,
  };
}

/**
 * Map an IPC permission resolve payload to a partial PermissionResolveInput
 * (excludes `status` and `decision` — those are set by the caller).
 */
export function ipcPermissionToResolve(extra?: {
  message?: string;
  updatedPermissions?: unknown[];
  updatedInput?: Record<string, unknown>;
}): Pick<PermissionResolveInput, 'message' | 'updatedPermissions' | 'updatedInput'> {
  return {
    message: extra?.message,
    updatedPermissions: extra?.updatedPermissions,
    updatedInput: extra?.updatedInput,
  };
}

// ─── Mailbox adapters ───

/**
 * Map a MailboxItem (core store, camelCase) back to the old `agent_mailbox`
 * row shape (snake_case). JSON fields are re-serialized to match the old
 * `SELECT * FROM agent_mailbox` shape.
 *
 * Column mapping notes:
 *  - `submittedRunId` → `submitted_during_run_id`
 *  - `resultingEventId` → `resulting_user_msg_id`
 *  - `attachments` (array|null) → `attachments_json` (JSON string)
 *  - `meta.constraints` → `constraints_json`
 *  - `meta.editHistory` → `edit_history_json`
 *  - `cancelReason` also feeds `failure_reason` (collapsed in core store)
 */
export function coreMailboxToIpcRow(item: MailboxItem | HostMailboxItem): Record<string, unknown> {
  const meta = item.meta ?? {};
  const constraints = meta.constraints;
  const editHistory = meta.editHistory;
  return {
    id: item.id,
    session_id: item.sessionId,
    submitted_during_run_id: item.submittedRunId,
    content: item.content,
    kind: item.kind,
    status: item.status,
    priority: item.priority,
    constraints_json: constraints !== undefined ? JSON.stringify(constraints) : null,
    attachments_json: item.attachments ? JSON.stringify(item.attachments) : null,
    source: item.source,
    client_msg_id: item.clientMsgId,
    created_at: item.createdAt,
    claim_token: item.claimToken,
    claim_expires_at: item.claimExpiresAt,
    observed_at: item.observedAt,
    observed_at_checkpoint: item.observedAtCheckpoint,
    observed_by_run_id: item.observedByRunId,
    injected_run_id: item.injectedRunId,
    claim_attempts: item.claimAttempts,
    last_claim_error: item.lastClaimError,
    edit_locked_at: item.editLockedAt,
    apply_mode: item.applyMode,
    applied_at: item.appliedAt,
    applied_at_checkpoint: item.appliedAtCheckpoint,
    applied_summary: item.appliedSummary,
    resulting_user_msg_id: item.resultingEventId,
    failure_reason: item.cancelReason,
    edit_history_json: editHistory !== undefined ? JSON.stringify(editHistory) : null,
    cancelled_at: item.cancelledAt,
    cancelled_by: item.cancelledBy,
    cancel_reason: item.cancelReason,
  };
}
