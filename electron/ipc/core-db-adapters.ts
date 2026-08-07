/**
 * core-db-adapters.ts — DTO adapter layer between the legacy IPC flat-row
 * shapes and the core store's CoreSession / NewEvent / StoredEvent.
 *
 * This is the ONLY file that knows about both the old snake_case DTO
 * shapes (consumed by the renderer and Worker) and the new core store
 * types. All mapping logic lives here — handlers and bridges call these
 * helpers and stay clean of field-level conversion.
 *
 * Write direction (IPC → core store):
 *   `ipcMessageToNewEvent` — flat message DTO → NewEvent (via ingestMessage)
 *   `ipcSessionToCoreCreate` / `ipcSessionToUpdate` — flat session DTO → core input
 *
 * Read direction (core store → IPC):
 *   `coreSessionToIpcRow` — CoreSession + extensions → old SessionRow shape
 *   `storedEventsToIpcMessages` — StoredEvent[] → old MessageRow[] (via
 *     projectTimelinePersistenceMessages for correct compaction/custom-type
 *     mapping)
 *
 * See plan 328 decision 2 for the field-by-field mapping contract.
 */

import type { Message, MessageContent } from '@duya/ai';
import {
  ingestMessage,
  projectTimelinePersistenceMessages,
  type MessageEntry,
  type CompactionEntry,
  type MessageTimelineEntry,
} from '@duya/agent/message';
import type {
  CoreSession,
  SessionCreateInput,
  SessionPatch,
  NewEvent,
  StoredEvent,
  CoreTask,
  TaskCreateInput,
  TaskUpdateInput,
  PermissionRequest,
  PermissionCreateInput,
  PermissionResolveInput,
  MailboxItem,
} from '../db/core';

// ─── Legacy flat message row type (re-exported for consumers that
//    project StoredEvent[] back to the old `messages` DTO shape) ───

/**
 * The legacy `messages` table row shape returned by `storedEventsToIpcMessages`.
 * Consumers that previously imported `MessageRow` from the old queries layer
 * should import this type instead — it captures the same fields the adapter
 * produces.
 */
export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  display_content: string | null;
  name: string | null;
  tool_call_id: string | null;
  token_usage: string | null;
  msg_type: string;
  thinking: string | null;
  tool_name: string | null;
  tool_input: string | null;
  parent_tool_call_id: string | null;
  viz_spec: string | null;
  status: string;
  seq_index: number;
  duration_ms: number | null;
  sub_agent_id: string | null;
  attachments: string | null;
  provider_state: string | null;
  thinking_signature: string | null;
  tool_signature: string | null;
  text_signature: string | null;
  created_at: number;
}

// ─── Content serialization (ported from old db-handlers.ts) ───

/**
 * Serialize message content (string | MessageContent[]) to the TEXT form
 * expected by the old `messages.content` column. User messages with image
 * blocks are reduced to text blocks joined by '\n'.
 */
export function serializeMessageContent(value: unknown, role?: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) && role === 'user') {
    const textBlocks = value.filter(
      (b: unknown) => (b as Record<string, unknown>).type === 'text',
    );
    return textBlocks.length > 0
      ? textBlocks.map((b: unknown) => (b as Record<string, string>).text || '').join('\n')
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** Serialize displayContent — null if empty, otherwise same as content. */
export function serializeDisplayContent(value: unknown, role?: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return serializeMessageContent(value, role);
}

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
    conductor_mode_enabled: ext.conductor_mode_enabled ?? 0,
    conductor_canvas_id: ext.conductor_canvas_id ?? null,
    draft_message: session.draft ?? '',
    source: ext.source ?? 'local',
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

// ─── Message adapters ───

/** Fields shared between the IPC message DTO and the @duya/ai Message type. */
interface IpcMessageDTO {
  id: string;
  session_id: string;
  role: string;
  content: string;
  display_content?: string | null;
  displayContent?: unknown;
  name?: string;
  tool_call_id?: string;
  token_usage?: string;
  msg_type?: string;
  thinking?: string;
  tool_name?: string;
  tool_input?: string;
  parent_tool_call_id?: string;
  viz_spec?: string;
  status?: string;
  seq_index?: number;
  duration_ms?: number;
  sub_agent_id?: string;
  attachments?: unknown[];
  created_at?: number;
  timestamp?: number;
}

/**
 * Construct a NewEvent from an IPC message DTO.
 *
 * The flat DTO is mapped to a @duya/ai Message, then `ingestMessage`
 * produces the AgentMessage (preserving all flat fields via pickKnown).
 * The AgentMessage is wrapped in a MessageEntry and returned as a NewEvent
 * ready for `MessageLog.appendBatch`.
 *
 * `msg_type` / `parent_tool_call_id` auto-derivation matches the old
 * `db:message:add` handler behavior (role='tool' → msg_type='tool_result',
 * parent_tool_call_id=tool_call_id).
 */
export function ipcMessageToNewEvent(
  sessionId: string,
  data: IpcMessageDTO,
  turnId?: string | null,
): NewEvent {
  const now = Date.now();
  const createdAt = data.created_at ?? data.timestamp ?? now;
  const role = data.role as Message['role'];
  const msgType = role === 'tool' ? 'tool_result' : (data.msg_type ?? 'text');
  const parentToolCallId =
    role === 'tool' ? (data.tool_call_id ?? null) : (data.parent_tool_call_id ?? null);
  const displayContent = data.display_content ?? serializeDisplayContent(data.displayContent, role);

  // Construct the @duya/ai Message with all flat fields.
  const message: Message = {
    role,
    content: data.content,
    id: data.id,
    name: data.name,
    tool_call_id: data.tool_call_id,
    timestamp: createdAt,
    msg_type: msgType,
    thinking: data.thinking,
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    parent_tool_call_id: parentToolCallId ?? undefined,
    viz_spec: data.viz_spec,
    status: data.status ?? 'done',
    seq_index: data.seq_index,
    duration_ms: data.duration_ms,
    sub_agent_id: data.sub_agent_id,
    attachments: data.attachments,
    displayContent: displayContent ?? undefined,
    // token_usage stored in metadata for round-trip
    metadata: data.token_usage ? { token_usage: data.token_usage } : undefined,
  };

  const agentMessage = ingestMessage(message, { index: 0 });

  const entry: MessageEntry = {
    type: 'message',
    id: data.id,
    parentId: null,
    createdAt,
    message: agentMessage,
  };

  return {
    id: data.id,
    sessionId,
    turnId: turnId ?? null,
    payload: entry,
    createdAt,
  };
}

/**
 * Map a single StoredEvent to the old `messages` row shape (snake_case).
 *
 * Uses `projectTimelinePersistenceMessages` for correct mapping of custom
 * AgentMessage types (runtimeContext, compactionSummary, etc.) back to the
 * flat Message shape. Returns null if the payload is unparseable or projects
 * to zero messages.
 *
 * `seq_index` is set from the StoredEvent's `seq` field.
 */
export function storedEventToIpcMessage(event: StoredEvent): MessageRow | null {
  let entry: MessageTimelineEntry;
  try {
    entry = JSON.parse(event.payload) as MessageTimelineEntry;
  } catch {
    return null;
  }

  const messages = projectTimelinePersistenceMessages([entry]);
  if (messages.length === 0) return null;
  const msg = messages[0];

  return messageToIpcRow(msg, event);
}

/**
 * Map StoredEvent[] to old `messages` row shape[] (snake_case).
 *
 * Parses all payloads, projects the full timeline via
 * `projectTimelinePersistenceMessages` (handles compaction checkpoints),
 * then zips with the original events to preserve `seq` ordering.
 */
export function storedEventsToIpcMessages(events: StoredEvent[]): MessageRow[] {
  if (events.length === 0) return [];

  const entries: MessageTimelineEntry[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < events.length; i++) {
    try {
      const entry = JSON.parse(events[i].payload) as MessageTimelineEntry;
      entries.push(entry);
      validIndices.push(i);
    } catch {
      // Skip unparseable payloads
    }
  }

  const messages = projectTimelinePersistenceMessages(entries);
  const rows: MessageRow[] = [];

  // Zip messages with events. In the common case (no compaction), each
  // entry produces exactly one message, so indices align. With compaction,
  // the checkpoint marker replaces the compacted prefix — we attach it to
  // the first compacted event's StoredEvent for seq/ordering purposes.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const eventIdx = validIndices[i] ?? validIndices[validIndices.length - 1] ?? i;
    const event = events[eventIdx];
    if (event) {
      rows.push(messageToIpcRow(msg, event));
    }
  }

  return rows;
}

/**
 * Map a projected Message to the old `messages` row shape.
 * Extracts signatures from content blocks and provider_state from metadata.
 */
function messageToIpcRow(msg: Message, event: StoredEvent): MessageRow {
  const content = serializeMessageContent(msg.content, msg.role);
  const displayContent = serializeDisplayContent(msg.displayContent, msg.role);
  const attachments = msg.attachments ? JSON.stringify(msg.attachments) : null;

  // Extract signatures from content blocks (if present)
  let thinkingSignature: string | null = null;
  let toolSignature: string | null = null;
  let textSignature: string | null = null;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block === 'object' && block !== null) {
        if (block.type === 'thinking' && 'signature' in block && block.signature) {
          thinkingSignature = block.signature as string;
        }
        if (block.type === 'tool_use' && 'signature' in block && block.signature) {
          toolSignature = block.signature as string;
        }
        if (block.type === 'text' && 'signature' in block && block.signature) {
          textSignature = block.signature as string;
        }
      }
    }
  }

  // Extract provider_state from metadata (if present)
  const metadata = msg.metadata as Record<string, unknown> | undefined;
  const providerState = metadata?.provider_state
    ? (typeof metadata.provider_state === 'string'
        ? metadata.provider_state
        : JSON.stringify(metadata.provider_state))
    : null;
  const tokenUsage = metadata?.token_usage
    ? (typeof metadata.token_usage === 'string'
        ? metadata.token_usage
        : JSON.stringify(metadata.token_usage))
    : null;

  return {
    id: msg.id ?? event.id,
    session_id: event.sessionId,
    role: msg.role,
    content,
    display_content: displayContent,
    name: msg.name ?? null,
    tool_call_id: msg.tool_call_id ?? null,
    token_usage: tokenUsage,
    msg_type: msg.msg_type ?? 'text',
    thinking: msg.thinking ?? null,
    tool_name: msg.tool_name ?? null,
    tool_input: msg.tool_input ?? null,
    parent_tool_call_id: msg.parent_tool_call_id ?? null,
    viz_spec: msg.viz_spec ?? null,
    status: msg.status ?? 'done',
    seq_index: event.seq,
    duration_ms: msg.duration_ms ?? null,
    sub_agent_id: msg.sub_agent_id ?? null,
    attachments,
    created_at: msg.timestamp ?? event.createdAt,
    provider_state: providerState,
    thinking_signature: thinkingSignature,
    tool_signature: toolSignature,
    text_signature: textSignature,
  };
}

// ─── Task adapters ───

/**
 * Map an IPC task create payload to TaskCreateInput.
 * Old snake_case fields → core camelCase.
 */
export function ipcTaskToCoreCreate(data: {
  id: string;
  session_id: string;
  subject: string;
  description: string;
  active_form?: string | null;
  owner?: string | null;
}): TaskCreateInput {
  return {
    id: data.id,
    sessionId: data.session_id,
    subject: data.subject,
    description: data.description,
    activeForm: data.active_form ?? null,
    owner: data.owner ?? null,
  };
}

/**
 * Map an IPC task update payload to TaskUpdateInput.
 * Only fields present in `data` are included.
 */
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

/**
 * Map a CoreTask back to the old `tasks` row shape (snake_case).
 * JSON-array fields are re-serialized to match the old `SELECT *` shape.
 */
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
export function corePermissionToIpcRow(perm: PermissionRequest): Record<string, unknown> {
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
export function coreMailboxToIpcRow(item: MailboxItem): Record<string, unknown> {
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
