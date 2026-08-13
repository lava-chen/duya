import type { FileAttachment, Message } from '../types.js';
import type { MailboxKind, MailboxRow } from '../session/db.js';
import {
  STATUS_TAG,
  TASK_ID_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/taskNotificationXml.js';
import {
  AgentMessageFactory,
  type AgentMessageClock,
  type AgentMessageIdGenerator,
} from './message-factories.js';
import type {
  AgentMessage,
  AgentMessageVisibility,
  RuntimeContextMessage,
} from './message-framework.js';
import { buildAttachmentContext } from '../utils/attachment-context.js';

/**
 * Pure adapters that convert runtime inputs (mailbox rows, task-notification
 * XML, hard replacements, attachment-derived context, and custom runtime
 * system info) into explicit {@link RuntimeContextMessage} entries.
 *
 * Contract:
 * - Pure: no claim/apply/dequeue side effects. Receives already-fetched data
 *   and only transforms it.
 * - mailbox and background_notification default to visibility='hidden'.
 * - Structured metadata (mailbox row IDs, claim tokens, task IDs) is preserved
 *   on metadata so callers can dedupe and correlate without sniffing content.
 * - Same mailbox row ID or notification task ID is dedupeable via
 *   {@link dedupeRuntimeContextMessages}.
 * - Provider compatibility projection
 *   ({@link projectRuntimeContextToProviderMessage}) is a one-way API
 *   adaptation; it never changes the domain message.
 */

// ─── Metadata keys ───────────────────────────────────────────────────────

/**
 * Stable metadata keys carried on {@link RuntimeContextMessage.metadata}
 * so downstream consumers (dedup, persistence, renderer) can identify the
 * origin without parsing message content.
 */
export const RUNTIME_CONTEXT_METADATA_KEYS = {
  /** string[] — mailbox row IDs absorbed into a guidance/replacement message. */
  mailboxRowIds: 'mailboxRowIds',
  /** string[] — claim tokens parallel to mailboxRowIds. */
  claimTokens: 'claimTokens',
  /** MailboxKind[] — the kind of each absorbed row. */
  mailboxKinds: 'mailboxKinds',
  /** string — the MailboxRow.source field of the first absorbed row. */
  mailboxSource: 'mailboxSource',
  /** string — parsed <task-id> from a task-notification XML. */
  taskId: 'taskId',
  /** string — parsed <tool-use-id> from a task-notification XML. */
  toolUseId: 'toolUseId',
  /** string — parsed <status> from a task-notification XML. */
  taskStatus: 'taskStatus',
  /** string[] — attachment IDs that contributed to the context. */
  attachmentIds: 'attachmentIds',
  /** string[] — attachment names that contributed to the context. */
  attachmentNames: 'attachmentNames',
  /** number — monotonic cwd "generation" identifying a working-directory switch. */
  cwdGeneration: 'cwdGeneration',
} as const;

// ─── Shared options ──────────────────────────────────────────────────────

export interface RuntimeContextAdapterOptions {
  readonly idGenerator?: AgentMessageIdGenerator;
  readonly clock?: AgentMessageClock;
  /** Override the per-source visibility default. */
  readonly visibility?: AgentMessageVisibility;
  /** Extra metadata merged into the produced message. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly seqIndex?: number;
}

function createFactory(options: RuntimeContextAdapterOptions): AgentMessageFactory {
  return new AgentMessageFactory({
    idGenerator: options.idGenerator,
    clock: options.clock,
  });
}

// ─── 1. Mailbox rows -> source='mailbox' ─────────────────────────────────

/**
 * Mailbox kinds that produce runtime guidance content. `background_notification`
 * is adapted separately via {@link adaptBackgroundNotification}.
 */
const MAILBOX_GUIDANCE_KINDS: ReadonlySet<MailboxKind> = new Set([
  'queued',
  'followup',
]);

/**
 * Wraps followup mailbox rows in a `<runtime-user-guidance>` block, matching
 * the legacy DuyaAgent format so the model sees identical content during the
 * incremental migration.
 *
 * Rows without a claim token are skipped (they were not successfully claimed
 * and should not become runtime context).
 *
 * All absorbed rows are collapsed into a single runtime_context message so
 * the model receives one coherent guidance block, matching the existing
 * runtime behavior.
 */
export function adaptMailboxRows(
  rows: readonly MailboxRow[],
  claimTokens: readonly string[],
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage[] {
  const usable: { row: MailboxRow; token: string }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (!MAILBOX_GUIDANCE_KINDS.has(row.kind)) continue;
    const token = claimTokens[i];
    if (!token) continue;
    usable.push({ row, token });
  }
  if (usable.length === 0) return [];

  const content = formatMailboxRuntimeInstruction(usable.map((entry) => entry.row));
  const factory = createFactory(options);
  const message = factory.createRuntimeContextMessage({
    source: 'mailbox',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: {
      ...options.metadata,
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: usable.map((entry) => entry.row.id),
      [RUNTIME_CONTEXT_METADATA_KEYS.claimTokens]: usable.map((entry) => entry.token),
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxKinds]: usable.map((entry) => entry.row.kind),
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxSource]: usable[0].row.source,
    },
  });
  return [message];
}

// ─── 2. Task-notification XML -> source='background_notification' ────────

/**
 * Adapts a `<task-notification>` XML envelope into a runtime_context message.
 * The raw XML is preserved as content so the model and renderer see the same
 * payload. The `<task-id>`, `<tool-use-id>`, and `<status>` fields are
 * extracted into metadata for deduplication and correlation without content
 * parsing.
 */
export function adaptTaskNotificationXml(
  xml: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const taskId = extractNotificationField(xml, TASK_ID_TAG);
  const toolUseId = extractNotificationField(xml, TOOL_USE_ID_TAG);
  const status = extractNotificationField(xml, STATUS_TAG);

  const metadata: Record<string, unknown> = { ...options.metadata };
  if (taskId) metadata[RUNTIME_CONTEXT_METADATA_KEYS.taskId] = taskId;
  if (toolUseId) metadata[RUNTIME_CONTEXT_METADATA_KEYS.toolUseId] = toolUseId;
  if (status) metadata[RUNTIME_CONTEXT_METADATA_KEYS.taskStatus] = status;

  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'background_notification',
    content: xml,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata,
  });
}

/**
 * Adapts a `background_notification` mailbox row into a runtime_context
 * message. The row's `content` is the `<task-notification>` XML envelope
 * produced by the sub-agent / background command producers, so this simply
 * delegates to {@link adaptTaskNotificationXml} and preserves the mailbox row
 * id for correlation. Deduplication is keyed by the parsed `<task-id>`.
 */
export function adaptBackgroundNotification(
  row: MailboxRow,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  return adaptTaskNotificationXml(row.content, {
    ...options,
    metadata: {
      ...options.metadata,
      [RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds]: [row.id],
    },
  });
}

// ─── 4. Attachment-derived context -> source='attachment' ────────────────

/**
 * Builds a runtime_context message from file attachments using
 * {@link buildAttachmentContext}. Returns `null` when no attachment yields
 * parseable context (no text, no image, no path). The attachment IDs and
 * names are preserved on metadata for correlation.
 *
 * Defaults to `visibility='hidden'`: the attachment is already surfaced as
 * a card in the renderer, so this context is model-only and must not be
 * re-rendered as a separate user message.
 *
 * Unlike transient mailbox/notification context, attachment context represents
 * the user's filed content and must survive a restart so the model can still
 * reference it later. Deduplication is handled by
 * {@link dedupeRuntimeContextMessages} on reload.
 */
export function adaptAttachmentContext(
  attachments: readonly FileAttachment[],
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage | null {
  const contextText = buildAttachmentContext([...attachments]);
  if (!contextText) return null;

  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'attachment',
    content: contextText,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: {
      ...options.metadata,
      [RUNTIME_CONTEXT_METADATA_KEYS.attachmentIds]: attachments.map((file) => file.id),
      [RUNTIME_CONTEXT_METADATA_KEYS.attachmentNames]: attachments.map((file) => file.name),
    },
  });
}

// ─── 5. Custom runtime system info -> source='custom' ────────────────────

/**
 * Adapts an arbitrary runtime system message into a runtime_context message
 * with `source='custom'`. Use this for any runtime input that does not fit
 * the other four categories (e.g. environment hints, feature flags).
 */
export function adaptCustomRuntimeContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'custom',
    content,
    visibility: options.visibility ?? 'visible',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}

// ─── 6. Incomplete-todo steering -> source='todo_gate' ───────────────────

/**
 * Adapts the todo-gate steering directive (injected before finalizing when
 * unfinished tasks remain) into a runtime_context message with
 * `source='todo_gate'`. Symmetric to the other runtime adapters so every
 * synthetic harness message flows through the same RuntimeContextMessage
 * framework. Defaults to visibility='hidden': the directive is model-only and
 * must not be re-rendered as a user turn.
 */
export function adaptTodoGateContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'todo_gate',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}

// ─── 7. Working-directory switch -> source='working_directory_switch' ────

/**
 * Adapts a working-directory switch notice into a runtime_context message.
 * The monotonic `cwdGeneration` is carried on metadata so consumers can dedupe
 * and correlate switches without parsing content (mirrors grok's
 * `cwd_generation`). Defaults to visibility='hidden': a harness directive, not
 * a user turn.
 */
export function adaptWorkingDirectorySwitch(
  content: string,
  cwdGeneration: number,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'working_directory_switch',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: {
      ...options.metadata,
      [RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration]: cwdGeneration,
    },
  });
}

// ─── 8. Post-compaction continuation -> source='auto_continue' ───────────

/**
 * Adapts the post-compaction "keep working" directive into a runtime_context
 * message. Mirrors grok's `AutoContinue`: after history is collapsed to a
 * summary, this nudges the model to continue the active task off the summary
 * instead of stopping or re-acknowledging the compaction boundary. Transient
 * (excluded from persistence) and mid-turn (does not start a new turn).
 */
export function adaptAutoContinueContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'auto_continue',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}

// ─── 9. Goal per-round continuation -> source='goal_summary' ─────────────

/**
 * Adapts the goal-mode per-round continuation (goal-state + sentinel +
 * verifier gaps) into a runtime_context message. Mirrors grok's
 * `GoalSummary`: a durable progress check-in that is user-visible but is
 * NOT a real user query — `runtimeContext:true` lets `lastRealUserQuery`
 * skip it when anchoring the final response. Defaults to visible so the
 * progress summary renders in the transcript.
 */
export function adaptGoalSummaryContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'goal_summary',
    content,
    visibility: options.visibility ?? 'visible',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}

// ─── 10. Research per-round continuation -> source='research_continuation'

/**
 * Same shape as {@link adaptGoalSummaryContext} for the research-mode
 * continuation. Durable, user-visible, mid-turn.
 */
export function adaptResearchContinuationContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'research_continuation',
    content,
    visibility: options.visibility ?? 'visible',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}

// ─── Deduplication ───────────────────────────────────────────────────────

/**
 * Deduplicates runtime_context messages by their identifying metadata.
 *
 * - mailbox messages: keyed by individual row IDs in
 *   {@link RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds}. A message is dropped
 *   only when every row ID it carries has already been seen; partial overlap
 *   keeps the message so new rows are never lost.
 * - background_notification messages: keyed by
 *   {@link RUNTIME_CONTEXT_METADATA_KEYS.taskId}. A message without a task ID
 *   is always kept (no dedup key).
 * - Other runtime_context and non-runtime-context messages are passed through
 *   untouched.
 *
 * The input array is never mutated; a new array is returned.
 */
export function dedupeRuntimeContextMessages<T extends AgentMessage>(
  messages: readonly T[],
): T[] {
  const seenMailboxRowIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const seenCwdGenerations = new Set<number>();
  const result: T[] = [];

  for (const message of messages) {
    if (message.role !== 'runtime_context') {
      result.push(message);
      continue;
    }

    if (message.source === 'mailbox') {
      const rowIds = readStringArray(
        message.metadata,
        RUNTIME_CONTEXT_METADATA_KEYS.mailboxRowIds,
      );
      if (rowIds.length > 0 && rowIds.every((id) => seenMailboxRowIds.has(id))) {
        continue;
      }
      for (const id of rowIds) {
        seenMailboxRowIds.add(id);
      }
      result.push(message);
      continue;
    }

    if (message.source === 'background_notification') {
      const taskId = readString(
        message.metadata,
        RUNTIME_CONTEXT_METADATA_KEYS.taskId,
      );
      if (taskId && seenTaskIds.has(taskId)) {
        continue;
      }
      if (taskId) {
        seenTaskIds.add(taskId);
      }
      result.push(message);
      continue;
    }

    if (message.source === 'working_directory_switch') {
      const gen = readNumber(
        message.metadata,
        RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration,
      );
      if (gen !== undefined) {
        if (seenCwdGenerations.has(gen)) {
          continue;
        }
        seenCwdGenerations.add(gen);
      }
      result.push(message);
      continue;
    }

    result.push(message);
  }

  return result;
}

// ─── Provider compatibility projection ───────────────────────────────────

// The canonical provider projection lives in message-projectors.ts (the pure
// boundary module, shared with the renderer-facing subpath). Re-exported here
// so existing adapter callers keep a single import site.
export { projectRuntimeContextToProviderMessage } from './message-projectors.js';

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Formats mailbox guidance rows into a `<runtime-user-guidance>` block.
 * Mirrors the legacy DuyaAgent format so the model sees identical content
 * during the incremental migration.
 */
function formatMailboxRuntimeInstruction(rows: readonly MailboxRow[]): string {
  const lines = rows
    .map((row, index) => {
      return `${index + 1}. (follow-up) ${row.content.trim()}`;
    })
    .filter((line) => line.trim().length > 0);

  return [
    '<runtime-user-guidance>',
    'The user sent the following instruction while you were already working.',
    'Incorporate it into the current plan at the next safe point. Do not mention this wrapper.',
    ...lines,
    '</runtime-user-guidance>',
  ].join('\n');
}

/**
 * Extracts the inner text of a `<tag>...</tag>` field from a
 * task-notification XML envelope. Values are XML-unescaped. Returns
 * `undefined` when the tag is absent.
 */
function extractNotificationField(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const match = regex.exec(xml);
  if (!match?.[1]) return undefined;
  return unescapeXml(match[1].trim());
}

function unescapeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function readStringArray(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : undefined;
}
