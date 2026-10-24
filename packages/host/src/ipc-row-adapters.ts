/**
 * ipc-row-adapters.ts — legacy row-shape adapters for the session / goal /
 * task domains, shared by the Host worker db bridge and the Desktop bridge.
 *
 * Moved out of Desktop's `core-db-adapters.ts` (plan 12 gate 1) so the Host
 * worker db bridge and the Desktop bridge emit byte-identical legacy row
 * shapes at the worker `db:request` boundary.
 */

import type {
  Task as HostTask,
  TaskCreateInput as HostTaskCreateInput,
  TaskStatus,
  TaskUpdateInput as HostTaskUpdateInput,
} from '@duya/agent-protocol';
import type { HostMailboxItem } from '@duya/agent-protocol/mailbox';
import type { SessionGoal } from '@duya/agent-protocol/goals';
import type { CoreSession, SessionCreateInput } from '@duya/data/session-store';
import type { MailboxItem } from '@duya/data/mailbox';

/**
 * Extension keys stored in `sessions.extensions` that map to top-level
 * columns in the old `chat_sessions` table.
 */
const SESSION_EXTENSION_KEYS = [
  'system_prompt',
  'context_summary',
  'context_summary_updated_at',
  'plan_mode_enabled',
  'goal_mode_enabled',
  'source',
] as const;

/**
 * Map a CoreSession back to the old `chat_sessions` row shape (snake_case).
 * Extension-bound fields are extracted to top-level columns to match the
 * old `SELECT * FROM chat_sessions` shape.
 *
 * `is_deleted` is derived from `status === 'deleted'` (0 or 1).
 * `generation` is always 0 (append-only store — generation乐观锁废弃).
 * `draft_message` is mapped from `draft`.
 * `permission_profile` is mapped from `permissionMode`.
 * `parent_id` is mapped from `parentSessionId`.
 */
export function coreSessionToIpcRow(session: CoreSession): Record<string, unknown> {
  const ext = session.extensions ?? {};
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    system_prompt: ext.system_prompt ?? '',
    working_directory: session.workingDirectory,
    project_name: session.projectName,
    status: session.status,
    mode: session.mode,
    permission_profile: session.permissionMode,
    provider_id: session.providerId,
    generation: 0,
    context_summary: ext.context_summary ?? '',
    context_summary_updated_at: ext.context_summary_updated_at ?? 0,
    is_deleted: session.status === 'deleted' ? 1 : 0,
    parent_id: session.parentSessionId,
    agent_profile_id: session.agentProfileId,
    agent_type: session.agentType,
    agent_name: session.agentName,
    ...(ext.checkout === undefined ? {} : { checkout: ext.checkout }),
    plan_mode_enabled: ext.plan_mode_enabled ?? 0,
    goal_mode_enabled: ext.goal_mode_enabled ?? 0,
    draft_message: session.draft ?? '',
    source: ext.source ?? 'local',
    pinned: ext.pinned ? 1 : 0,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    // Plan 549 (Track A): surface archive metadata so the renderer can
    // render the archived section without an extra IPC round-trip per row.
    rollout_path: session.rolloutPath,
    archived_at: session.archivedAt,
    archived_path: session.archivedPath,
    // Plan 582 (G4): the sidebar's real sort key travels with the row so the
    // renderer can order by it directly instead of guessing from
    // `updated_at` — which archiving, pinning and renaming all bump.
    recency_at: session.recencyAt ?? session.updatedAt,
    last_turn_started_at: session.lastTurnStartedAt,
  };
}

/**
 * Map a legacy IPC session create payload to the core session create input.
 *
 * `permissionMode` is the second argument, not a field of the payload: the
 * caller resolves it (via `resolveSessionPermissionProfile`) before calling
 * this function — the adapter does not do business logic.
 *
 * Old `parent_id` / `parent_session_id` are merged into `parentSessionId`.
 * Old `draft_message` → `draft`. Extension-bound fields (system_prompt,
 * context summaries, etc.) go to `extensions`.
 *
 * Owned here so the Host worker db bridge and the Desktop bridge turn the
 * same flat payload into the same session row.
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
    permissionMode,
    agentProfileId: (data.agent_profile_id as string | null | undefined) ?? null,
    parentSessionId,
    draft: (data.draft_message as string | null | undefined) ?? null,
    extensions,
    ...(data.title !== undefined ? { title: data.title as string } : {}),
    ...(data.working_directory !== undefined
      ? { workingDirectory: data.working_directory as string }
      : {}),
    ...(data.project_name !== undefined ? { projectName: data.project_name as string } : {}),
    ...(data.status !== undefined ? { status: data.status as string } : {}),
    ...(data.model !== undefined ? { model: data.model as string } : {}),
    ...(data.provider_id !== undefined ? { providerId: data.provider_id as string } : {}),
    ...(data.mode !== undefined ? { mode: data.mode as string } : {}),
    ...(data.agent_type !== undefined ? { agentType: data.agent_type as string } : {}),
    ...(data.agent_name !== undefined ? { agentName: data.agent_name as string } : {}),
    ...(data.created_at !== undefined ? { createdAt: data.created_at as number } : {}),
    ...(data.updated_at !== undefined ? { updatedAt: data.updated_at as number } : {}),
  };
}

function requireHostTaskStatus(status: string): TaskStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') return status;
  throw new Error(`Unsupported task status: ${status}`);
}

interface IpcTaskCoreCreate {
  id: string;
  sessionId: string;
  subject: string;
  description: string;
  status?: string;
  activeForm: string | null;
  owner: string | null;
}

function ipcTaskToCoreCreate(data: {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  status?: string;
  active_form?: string | null;
  owner?: string | null;
}): IpcTaskCoreCreate {
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

/** Map a legacy IPC task create payload to the Host task contract. */
export function ipcTaskToHostCreate(
  data: Parameters<typeof ipcTaskToCoreCreate>[0],
): HostTaskCreateInput {
  const task = ipcTaskToCoreCreate(data);
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: requireHostTaskStatus(task.status ?? 'pending'),
    ...(task.activeForm === null ? {} : { activeForm: task.activeForm }),
    ...(task.owner === null ? {} : { owner: task.owner }),
    blocks: [],
    blockedBy: [],
    metadata: {},
  };
}

function ipcTaskToUpdate(data: Record<string, unknown>) {
  const patch: {
    subject?: string;
    description?: string;
    status?: string;
    activeForm?: string | null;
    owner?: string | null;
    blocks?: string[];
    blockedBy?: string[];
    metadata?: Record<string, unknown>;
  } = {};
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

/** Map a legacy IPC task patch to the Host task contract. */
export function ipcTaskToHostUpdate(data: Record<string, unknown>): HostTaskUpdateInput {
  const task = ipcTaskToUpdate(data);
  return {
    ...(task.subject === undefined ? {} : { subject: task.subject }),
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.status === undefined ? {} : { status: requireHostTaskStatus(task.status) }),
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    ...(task.blocks === undefined ? {} : { blocks: task.blocks }),
    ...(task.blockedBy === undefined ? {} : { blockedBy: task.blockedBy }),
    ...(task.metadata === undefined ? {} : { metadata: task.metadata }),
  };
}

/** Map a Host task back to the legacy task row shape at the IPC boundary. */
export function hostTaskToIpcRow(task: HostTask): Record<string, unknown> {
  if (task.sessionId === undefined || task.createdAt === undefined || task.updatedAt === undefined) {
    throw new Error(`Host task ${task.id} is missing persistence metadata`);
  }
  return {
    id: task.id,
    session_id: task.sessionId,
    subject: task.subject,
    description: task.description,
    status: task.status,
    active_form: task.activeForm ?? null,
    owner: task.owner ?? null,
    blocks: JSON.stringify(task.blocks),
    blocked_by: JSON.stringify(task.blockedBy),
    metadata: JSON.stringify(task.metadata ?? {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

/**
 * Map a mailbox item back to the legacy `agent_mailbox` row shape
 * (snake_case) — the shape the worker reads at the `db:request` boundary.
 *
 * Column mapping notes:
 *  - `submittedRunId` → `submitted_during_run_id`
 *  - `resultingEventId` → `resulting_user_msg_id`
 *  - `attachments` (array|null) → `attachments_json` (JSON string)
 *  - `meta.constraints` → `constraints_json`
 *  - `meta.editHistory` → `edit_history_json`
 *  - `cancelReason` also feeds `failure_reason` (collapsed in the core store)
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

/**
 * Map a SessionGoal back to the `session_goals` row shape (snake_case).
 * The agent reads this on session resume to restore the in-memory
 * TokenBudgetManager's accumulated counters.
 */
export function coreGoalToIpcRow(goal: SessionGoal): Record<string, unknown> {
  return {
    id: goal.id,
    session_id: goal.sessionId,
    goal_text: goal.goalText,
    status: goal.status,
    token_budget: goal.tokenBudget,
    tokens_used: goal.tokensUsed,
    time_used_seconds: goal.timeUsedSeconds,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
    completed_at: goal.completedAt,
  };
}
