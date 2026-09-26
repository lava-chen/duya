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
  type MessageSource,
  DEFAULT_MESSAGE_SOURCE,
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
  SessionGoal,
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
  /** Token-accounting: model id that produced this message (per-message). */
  model: string;
  /** Token-accounting: provider id that produced this message (per-message). */
  provider_id: string;
  attachments: string | null;
  provider_state: string | null;
  thinking_signature: string | null;
  tool_signature: string | null;
  text_signature: string | null;
  created_at: number;
  /** Plan 486: thread/fork reference id (mirrors message metadata threadMeta). */
  reply_to_id?: string | null;
  /** Plan 486: true when the row belongs to a thread's branched layer. */
  branched?: boolean | null;
  /**
   * Plan 489 P0.1: message origin classifier. Null for legacy rows written
   * before the classifier existed — those stay hidden from bot-direct views
   * (see `DEFAULT_MESSAGE_SOURCE` backfill note in @duya/agent/message).
   */
  source?: MessageSource | null;
  /**
   * Plan 489 P2.2: SendMessageTool card payload (attachment url/alt, widget
   * options, cursor-agent bcId, secret-request descriptor, text images),
   * JSON-serialized from message metadata.sendMessage. Null for plain rows.
   */
  send_message_meta?: string | null;
  /**
   * Plan 477 P4.4: bot→bot DM marker payload (direction/peer/intent),
   * JSON-serialized from message metadata.agentDm. Null for plain rows.
   */
  agent_dm_meta?: string | null;
  /** Plan 478: shared-room post payload (JSON). */
  group_post_meta?: string | null;
  /**
   * Compaction marker (round-trips `Message.isCompactSummary` so MessageItem
   * picks the CompactSummary branch after reload). Derived from the durable
   * compaction timeline entry by `projectTimelinePersistenceMessages`.
   */
  is_compact_summary?: boolean | null;
  /** Compaction marker: the compaction boundary id this summary belongs to. */
  compact_boundary_id?: string | null;
  /** Compaction marker: number of messages folded into this summary. */
  compacted_message_count?: number | null;
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

// ─── Message source classifier (plan 489 P0.1) ───

/**
 * Runtime-context msg_type cues that mark system-generated traffic
 * (mailbox notifications, task notifications, mode/memory/goal summaries,
 * attachment carries, runtime context injections).
 */
const RUNTIME_CONTEXT_MSG_TYPES: ReadonlySet<string> = new Set([
  'mailbox',
  'task-notification',
  'task_notification',
  'mode',
  'mode_changed',
  'memory',
  'goal_summary',
  'research_continuation',
  'attachment',
  'runtime_context',
]);

/**
 * Classify the origin of a flat IPC message DTO (plan 489 P0.1).
 *
 * Precedence (highest first):
 *   1. explicit `source` — wins when it is a known MessageSource value;
 *     unknown strings are ignored (fall through to inference);
 *   2. `role` — user → 'user', system → 'system', tool → 'tool_use'
 *     (a tool_result block is tool traffic regardless of any msg_type hint);
 *   3. `msg_type` — thinking → 'thinking', tool_use/tool_result →
 *     'tool_use', runtime-context cues → 'system' (case-insensitive);
 *   4. default — 'scratchpad' (plain assistant text / everything else).
 */
export function inferMessageSource(dto: {
  role?: string;
  msg_type?: string;
  source?: string;
}): MessageSource {
  const explicit = dto.source;
  if (
    explicit === 'user' ||
    explicit === 'send_message' ||
    explicit === 'tool_use' ||
    explicit === 'thinking' ||
    explicit === 'scratchpad' ||
    explicit === 'system' ||
    explicit === 'channel_mirror' ||
    // Plan 490 P1: ReactToMessage tapback rows.
    explicit === 'reaction' ||
    // Plan 477 P4.4: bot→bot DM marker rows.
    explicit === 'agent_dm' ||
    // Plan 478: shared-room entries (bot PostToRoom + room lifecycle notes).
    explicit === 'group' ||
    explicit === 'group_system'
  ) {
    return explicit;
  }

  if (dto.role === 'user') return 'user';
  if (dto.role === 'system') return 'system';
  if (dto.role === 'tool') return 'tool_use';

  const msgType = (dto.msg_type ?? '').toLowerCase();
  if (msgType === 'thinking') return 'thinking';
  if (msgType === 'tool_use' || msgType === 'tool_result') return 'tool_use';
  if (RUNTIME_CONTEXT_MSG_TYPES.has(msgType)) return 'system';

  return DEFAULT_MESSAGE_SOURCE;
}

/** Test-only alias — keeps the public surface free of `__test__` noise. */
export const __test__inferMessageSource = inferMessageSource;

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
  /** Token-accounting: model id that produced this message (per-message,
   *  first-class — NOT metadata). Empty string when unknown/legacy. */
  model?: string;
  /** Token-accounting: provider id that produced this message (per-message,
   *  first-class — NOT metadata). Empty string when unknown/legacy. */
  provider_id?: string;
  /** Per-message attribution, camelCase journal form: Journal.fire copies
   *  the @duya/ai Message field names verbatim. */
  providerId?: string;
  /** Per-message provider API format ('anthropic' | 'openai-chat' | ...);
   *  part of the provider_state triple used for thinking replay. */
  api?: string;
  attachments?: unknown[];
  /**
   * Plan 489 P0.1: explicit origin classifier. Honored when it is a known
   * MessageSource value (SendMessageTool sends 'send_message'); unknown
   * strings fall through to `inferMessageSource` inference.
   */
  source?: string;
  created_at?: number;
  timestamp?: number;
  /**
   * Tool-result metadata worth persisting. Only small, rewind-relevant keys
   * survive (whitelist below) — heavy renderer-only payloads such as browser
   * screenshots must not bloat rollout files.
   */
  metadata?: Record<string, unknown>;
  /** Compaction marker: true when this row is a compact summary. */
  is_compact_summary?: boolean;
  /** Compaction marker: compaction boundary id this summary belongs to. */
  compact_boundary_id?: string | null;
  /** Compaction marker: number of messages folded into this summary. */
  compacted_message_count?: number | null;
}

/**
 * Metadata keys persisted into the rollout payload (plan 429 #3 rewind
 * linkage). `preImageSha`/`filePath` come from Edit/Write; `fileSnapshots`
 * from ApplyPatch's multi-file semantics. `threadMeta` (plan 486) carries the
 * replyToId/branched fork markers so a branched message stays durable and
 * `getThread` can be served after a reload.
 */
const PERSISTED_METADATA_KEYS = [
  'preImageSha',
  'filePath',
  'fileSnapshots',
  'threadMeta',
  // Plan 489 P2.2: SendMessageTool card payloads (attachment url/alt,
  // widget options, cursor-agent bcId, secret-request descriptor, text
  // images) ride under this single namespaced key so bot-direct cards
  // survive reload.
  'sendMessage',
  // Plan 490 P1: ReactToMessage tapback descriptor (target message id,
  // emoji, reacting agent) rides under this key so the reaction pill
  // renderer can group rows onto their target bubbles after reload.
  'reaction',
  // Plan 497: bot→bot DM marker payload (direction/peer/clientMsgId/raw
  // text) — without it the persisted marker rows lose their card metadata
  // on round-trip and the transcript renders them as plain bubbles instead
  // of the collapsed DM chip (observed: every marker degraded after reload).
  'agentDm',
  // Plan 478: shared-room payload (room/roomName/memberId/memberName/
  // clientMsgId) — the room view and the group orchestrator both read the
  // member identity back out of the persisted room transcript entries.
  'groupPost',
] as const;

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
  // Plan 489 P0.1: the adapter OWNS the source classification. Caller
  // metadata.source is never trusted — the inferred (or explicit) value is
  // mirrored into metadata.source below (belt-and-suspenders for projector
  // round-trips that drop the MessageEntry-level field).
  const source = inferMessageSource(data);

  // Persist token_usage plus whitelisted snapshot metadata for round-trip
  // (preImageSha/fileSnapshots drive file restore on session rewind).
  const persistedMetadata: Record<string, unknown> = {
    ...(data.metadata
      ? Object.fromEntries(
          PERSISTED_METADATA_KEYS.filter((key) => data.metadata?.[key] !== undefined).map((key) => [
            key,
            data.metadata![key],
          ]),
        )
      : {}),
    ...(data.token_usage ? { token_usage: data.token_usage } : {}),
    // Adapter-controlled: overrides any caller-supplied metadata.source.
    source,
  };

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
    // Token-accounting: per-message model/provider_id ride as first-class
    // Message fields (not metadata), round-tripping through the rollout.
    // providerId/api accept both snake_case (legacy DB rows) and camelCase
    // (journal DTO copies the @duya/ai Message field names verbatim).
    model: data.model || undefined,
    providerId: data.provider_id || data.providerId || undefined,
    api: (data.api as Message['api']) || undefined,
    attachments: data.attachments,
    source,
    displayContent: displayContent ?? undefined,
    metadata: Object.keys(persistedMetadata).length > 0 ? persistedMetadata : undefined,
    // Compaction markers (snake_case row column → @duya/ai Message field).
    isCompactSummary: data.is_compact_summary === true ? true : undefined,
    compactBoundaryId: data.compact_boundary_id ?? undefined,
    compactedMessageCount: data.compacted_message_count ?? undefined,
  };

  const agentMessage = ingestMessage(message, { index: 0 });

  const entry: MessageEntry = {
    type: 'message',
    id: data.id,
    parentId: null,
    createdAt,
    message: agentMessage,
    source,
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

  return messageToIpcRow(msg, event, (entry as MessageEntry).source);
}

/**
 * Map a single in-memory NewEvent to the old `messages` row shape.
 *
 * Used by the db-bridge `message:append` broadcast: the events have just
 * been handed to MessageLog.appendBatch and never round-tripped through
 * the rollout file, so `payload` is still a plain object. Feeding them
 * straight into `storedEventToIpcMessage` would JSON.parse("[object
 * Object]"), throw, and silently broadcast null rows — which the
 * BotDirectChatView realtime merge drops (plan 489 P0.3 regression:
 * SendMessage landed in the DB but only appeared after a refresh).
 *
 * seq has not been assigned at broadcast time (appendBatch assigns it
 * during storage), so a -1 sentinel is used; the renderer cursor
 * (useBotDirectTranscript) tolerates it and the next refresh re-reads
 * authoritative seq values.
 */
export function newEventToIpcMessage(event: NewEvent): MessageRow | null {
  return storedEventToIpcMessage({
    id: event.id,
    sessionId: event.sessionId,
    seq: -1,
    turnId: event.turnId ?? null,
    kind: 'assistant',
    payload: JSON.stringify(event.payload),
    createdAt: event.createdAt,
  });
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

  // Parse payloads and keep only message/compaction entries for projection.
  // Rollout process events (rebase / hook_invoked / ...) are audit rows:
  // `projectTimelinePersistenceMessages` (via buildAgentContext) drops them,
  // so feeding them in would shift the message↔event pairing below and
  // corrupt seq/createdAt/turnId for every row after the first event.
  const eventById = new Map<string, StoredEvent>();
  const sourceById = new Map<string, MessageSource>();
  const entries: MessageTimelineEntry[] = [];
  for (const event of events) {
    try {
      const entry = JSON.parse(event.payload) as MessageTimelineEntry;
      if (entry.type !== 'message' && entry.type !== 'compaction') continue;
      entries.push(entry);
      if (entry.id && !eventById.has(entry.id)) {
        eventById.set(entry.id, event);
        // Plan 489 P0.1: preserve the entry-level source classifier so the
        // projected row carries it (projection drops unknown flat fields).
        if (entry.type === 'message' && entry.source) {
          sourceById.set(entry.id, entry.source);
        }
      }
    } catch {
      // Skip unparseable payloads
    }
  }

  const messages = projectTimelinePersistenceMessages(entries);
  const rows: MessageRow[] = [];

  // Pair each projected message back to its source StoredEvent BY ID, not by
  // position: the projection may drop entries (compaction prefix collapse,
  // hidden messages) or synthesize markers, so index-based zipping misaligns
  // metadata whenever the trace is not 1:1.
  for (const msg of messages) {
    let event = msg.id ? eventById.get(msg.id) : undefined;
    if (!event && msg.id?.endsWith(':checkpoint')) {
      // projectTimelinePersistenceMessages synthesizes a compaction marker
      // with id `${checkpoint.id}:checkpoint`; attach it to the compaction
      // entry's StoredEvent for seq/ordering purposes.
      event = eventById.get(msg.id.slice(0, -':checkpoint'.length));
    }
    if (event) {
      rows.push(messageToIpcRow(msg, event, msg.id ? sourceById.get(msg.id) : undefined));
    }
  }

  return rows;
}

/**
 * Map a projected Message to the old `messages` row shape.
 * Extracts signatures from content blocks and provider_state from metadata.
 * `entrySource` (plan 489 P0.1) carries the MessageEntry-level classifier
 * straight from the rollout payload; falls back to the projected message's
 * own fields for in-memory replays. Legacy rows with no classifier anywhere
 * map to null and stay hidden from bot-direct views.
 */
function messageToIpcRow(
  msg: Message,
  event: StoredEvent,
  entrySource?: MessageSource,
): MessageRow {
  const content = serializeMessageContent(msg.content, msg.role);
  const displayContent = serializeDisplayContent(msg.displayContent, msg.role);
  const attachments = msg.attachments ? JSON.stringify(msg.attachments) : null;

  // Extract signatures from content blocks (if present). duya-native blocks
  // carry thinkingSignature / thoughtSignature / textSignature; the bare
  // `signature` fallback covers Claude-imported blocks.
  let thinkingSignature: string | null = null;
  let toolSignature: string | null = null;
  let textSignature: string | null = null;
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (typeof block === 'object' && block !== null) {
        const record = block as unknown as Record<string, unknown>;
        if (block.type === 'thinking') {
          const sig = record.thinkingSignature ?? record.signature;
          if (typeof sig === 'string' && sig) thinkingSignature = sig;
        }
        if (block.type === 'tool_use') {
          const sig = record.thoughtSignature ?? record.signature;
          if (typeof sig === 'string' && sig) toolSignature = sig;
        }
        if (block.type === 'text') {
          const sig = record.textSignature ?? record.signature;
          if (typeof sig === 'string' && sig) textSignature = sig;
        }
      }
    }
  }

  // Extract provider_state from metadata (if present). When absent, derive
  // it from the Message's own per-message attribution fields (set by the
  // agent loop at push time): a reloaded session needs {api, providerId,
  // model} so transformMessages.isSameModel recognizes same-model history
  // and replays thinking blocks natively instead of downgraded text.
  const metadata = msg.metadata as Record<string, unknown> | undefined;
  const metadataProviderState = metadata?.provider_state
    ? (typeof metadata.provider_state === 'string'
        ? metadata.provider_state
        : JSON.stringify(metadata.provider_state))
    : null;
  const derivedProviderState =
    msg.api || msg.providerId || msg.model
      ? JSON.stringify({ api: msg.api, providerId: msg.providerId, model: msg.model })
      : null;
  const providerState = metadataProviderState ?? derivedProviderState;
  // token_usage round-trips through metadata (journal write path), but the
  // timeline projection also restores the top-level `tokenUsage` field
  // (LEGACY_KNOWN_KEYS) for in-memory/replayed messages — read both.
  const rawTokenUsage = msg.metadata?.token_usage ?? (msg as { tokenUsage?: unknown }).tokenUsage;
  const tokenUsage = rawTokenUsage !== undefined && rawTokenUsage !== null
    ? (typeof rawTokenUsage === 'string' ? rawTokenUsage : JSON.stringify(rawTokenUsage))
    : null;

  // Plan 486: thread/fork markers are surfaced as flat row columns so both the
  // renderer transcript and the agent reload path can rebuild thread metadata.
  const threadMeta = metadata?.threadMeta as
    | { replyToId?: string; branched?: boolean }
    | undefined;
  const rowSource =
    entrySource ??
    (msg as { source?: MessageSource }).source ??
    ((metadata?.source as MessageSource | undefined) ?? null);

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
    // Token-accounting: per-message model/provider_id round-trip from the
    // first-class Message fields (empty string when unknown/legacy).
    model: (msg as { model?: string }).model ?? '',
    provider_id: (msg as { providerId?: string }).providerId ?? '',
    attachments,
    created_at: msg.timestamp ?? event.createdAt,
    provider_state: providerState,
    thinking_signature: thinkingSignature,
    tool_signature: toolSignature,
    text_signature: textSignature,
    reply_to_id: threadMeta?.replyToId ?? null,
    branched: threadMeta?.branched === true ? true : null,
    source: rowSource,
    send_message_meta:
      metadata?.sendMessage != null
        ? JSON.stringify(metadata.sendMessage)
        : null,
    agent_dm_meta:
      metadata?.agentDm != null
        ? JSON.stringify(metadata.agentDm)
        : null,
    group_post_meta:
      metadata?.groupPost != null
        ? JSON.stringify(metadata.groupPost)
        : null,
    is_compact_summary:
      (msg as { isCompactSummary?: boolean }).isCompactSummary === true ? true : null,
    compact_boundary_id:
      (msg as { compactBoundaryId?: string }).compactBoundaryId ?? null,
    compacted_message_count:
      (msg as { compactedMessageCount?: number }).compactedMessageCount ?? null,
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

// ─── Goal adapters (Plan 331 Phase 2) ───

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
