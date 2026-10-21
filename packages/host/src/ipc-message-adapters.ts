/**
 * ipc-message-adapters.ts — DTO adapter layer between the legacy flat message
 * row shapes (consumed by the Worker and the renderer) and the Host-owned
 * message timeline (MessageEntry payloads).
 *
 * This module is the SINGLE definition of the field-level mapping contract
 * (plan 328 decision 2). It was moved verbatim out of Desktop's
 * `apps/desktop/src/main/ipc/core-db-adapters.ts` so the Host worker db bridge
 * and the Desktop bridge serve the exact same conversion — the worker's
 * `message:add` / `message:append` / `session:loadMessages` frames must
 * produce byte-identical timeline entries no matter which process owns the
 * stores.
 *
 * Write direction (flat DTO → timeline):
 *   `ipcMessageToNewEvent` — flat message DTO → NewEvent (via ingestMessage)
 *
 * Read direction (timeline → flat DTO):
 *   `storedEventToIpcMessage` / `storedEventsToIpcMessages` — StoredEvent(s)
 *     → legacy `messages` row shape (via projectTimelinePersistenceMessages
 *     for correct compaction/custom-type mapping)
 *   `hostMessageItemsToIpcMessages` — Host message API projection → rows
 */

import type { Message } from '@duya/ai';
import { ingestMessage } from '@duya/agent-protocol';
import type { HostMessageItem } from '@duya/agent-protocol';
import {
  type MessageEntry,
  type MessageTimelineEntry,
  type MessageSource,
  DEFAULT_MESSAGE_SOURCE,
} from '@duya/agent-protocol/message-timeline';
import { projectTimelinePersistenceMessages } from '@duya/agent-protocol/transcript';
import type { NewEvent, StoredEvent } from '@duya/data';

/** The legacy `messages` table row shape returned by the read direction. */
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
   * (see `DEFAULT_MESSAGE_SOURCE` in @duya/agent-protocol/message-timeline).
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
  /** Channel send/receive marker payload (JSON), from metadata.channelMsg. */
  channel_msg_meta?: string | null;
  /** Routine lifecycle marker payload (JSON), from metadata.routine. */
  routine_meta?: string | null;
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
  // Channel send/receive marker payload (direction/address/platform/chat/
  // senderName/text) — the bot-direct chat's channel chips and their detail
  // overlay read this back after reload.
  'channelMsg',
  // Routine lifecycle marker payload (action/name/routineId) — the bot-direct
  // chat's routine chips read this back after reload.
  'routine',
] as const;

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
    explicit === 'group_system' ||
    // Channel send/receive marker rows (bot-direct chat chips).
    explicit === 'channel_activity' ||
    // Routine lifecycle marker rows (bot-direct chat chips).
    explicit === 'routine_activity'
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

/** Test alias kept so the Desktop pure-function tests keep their import path. */
export const __test__inferMessageSource = inferMessageSource;

/**
 * Construct a NewEvent from an IPC message DTO.
 *
 * The flat DTO is mapped to a @duya/ai Message, then `ingestMessage`
 * produces the AgentMessage (preserving all flat fields via pickKnown).
 * The AgentMessage is wrapped in a MessageEntry and returned as a NewEvent
 * ready for the Host timeline append.
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

  // Construct the @duya/ai Message with all flat fields. Optional fields are
  // spread conditionally (Host compiles with exactOptionalPropertyTypes).
  const message: Message = {
    role,
    content: data.content,
    id: data.id,
    ...(data.name === undefined ? {} : { name: data.name }),
    ...(data.tool_call_id === undefined ? {} : { tool_call_id: data.tool_call_id }),
    timestamp: createdAt,
    msg_type: msgType,
    ...(data.thinking === undefined ? {} : { thinking: data.thinking }),
    ...(data.tool_name === undefined ? {} : { tool_name: data.tool_name }),
    ...(data.tool_input === undefined ? {} : { tool_input: data.tool_input }),
    ...(parentToolCallId === null ? {} : { parent_tool_call_id: parentToolCallId }),
    ...(data.viz_spec === undefined ? {} : { viz_spec: data.viz_spec }),
    status: data.status ?? 'done',
    ...(data.seq_index === undefined ? {} : { seq_index: data.seq_index }),
    ...(data.duration_ms === undefined ? {} : { duration_ms: data.duration_ms }),
    ...(data.sub_agent_id === undefined ? {} : { sub_agent_id: data.sub_agent_id }),
    // Token-accounting: per-message model/provider_id ride as first-class
    // Message fields (not metadata), round-tripping through the rollout.
    // providerId/api accept both snake_case (legacy DB rows) and camelCase
    // (journal DTO copies the @duya/ai Message field names verbatim).
    ...(data.model ? { model: data.model } : {}),
    ...(data.provider_id || data.providerId
      ? { providerId: data.provider_id || data.providerId }
      : {}),
    ...(data.api ? { api: data.api as Message['api'] } : {}),
    ...(data.attachments === undefined ? {} : { attachments: data.attachments }),
    source,
    ...(displayContent === null ? {} : { displayContent }),
    ...(Object.keys(persistedMetadata).length > 0 ? { metadata: persistedMetadata } : {}),
    // Compaction markers (snake_case row column → @duya/ai Message field).
    ...(data.is_compact_summary === true ? { isCompactSummary: true } : {}),
    ...(data.compact_boundary_id === undefined || data.compact_boundary_id === null
      ? {}
      : { compactBoundaryId: data.compact_boundary_id }),
    ...(data.compacted_message_count === undefined
      ? {}
      : { compactedMessageCount: data.compacted_message_count }),
  } as Message;

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
  if (msg === undefined) return null;

  return messageToIpcRow(msg, event, (entry as MessageEntry).source);
}

/**
 * Map a single in-memory NewEvent to the old `messages` row shape.
 *
 * Used by bridge `message:append` broadcasts: the events have just been
 * handed to the timeline append and never round-tripped through the rollout
 * file, so `payload` is still a plain object. Feeding them straight into
 * `storedEventToIpcMessage` would JSON.parse("[object Object]"), throw, and
 * silently produce null rows.
 *
 * seq has not been assigned at broadcast time (the append assigns it during
 * storage), so a -1 sentinel is used; consumers tolerate it and the next
 * refresh re-reads authoritative seq values.
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
  // `projectTimelinePersistenceMessages` drops them, so feeding them in would
  // shift the message↔event pairing below and corrupt seq/createdAt/turnId
  // for every row after the first event.
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
  // unsupported message roles) or synthesize markers, so index-based zipping
  // misaligns metadata whenever the trace is not 1:1.
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

/** Adapt the Host message API projection through the existing IPC DTO mapper. */
export function hostMessageItemsToIpcMessages(
  sessionId: string,
  items: readonly HostMessageItem[],
): MessageRow[] {
  const events: StoredEvent[] = items.map((item) => ({
    id: item.id,
    sessionId,
    seq: item.sequence,
    turnId: item.turnId,
    kind: (item.entry.type === 'message' ? item.entry.message.role : 'compaction') as StoredEvent['kind'],
    payload: JSON.stringify(item.entry),
    createdAt: item.createdAt,
  }));
  return storedEventsToIpcMessages(events);
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
  entrySource: MessageSource | undefined,
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
    channel_msg_meta:
      metadata?.channelMsg != null
        ? JSON.stringify(metadata.channelMsg)
        : null,
    routine_meta:
      metadata?.routine != null
        ? JSON.stringify(metadata.routine)
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
