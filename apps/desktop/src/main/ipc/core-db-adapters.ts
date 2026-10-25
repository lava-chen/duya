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

import type { HostPermissionRequest } from '@duya/agent-protocol';
import type {
  SessionPatch,
  CoreTask,
  TaskCreateInput,
  TaskUpdateInput,
  PermissionCreateInput,
  PermissionResolveInput,
} from '../db/core';

// ─── Session adapters ───

/**
 * `ipcSessionToCoreCreate` moved to `@duya/host/ipc-row-adapters` (the Host
 * worker db bridge creates sessions from the same flat payload, so both
 * bridges must agree on the mapping).
 */
export { ipcSessionToCoreCreate } from '@duya/host/ipc-row-adapters';

/**
 * Map an IPC session update payload to SessionPatch.
 * Only fields present in `data` are included in the patch.
 * Extension-bound fields are NOT handled here — callers use setExtension
 * for those.
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
 * `coreMailboxToIpcRow` moved to `@duya/host/ipc-row-adapters` (plan 12
 * gate 1: the Host worker db bridge serves the mailbox domain and must emit
 * the same legacy row shape).
 */
export { coreMailboxToIpcRow } from '@duya/host/ipc-row-adapters';
