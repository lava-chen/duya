/**
 * Plan 486: message thread / fork branched-layer pure functions.
 *
 * A "thread" is NOT a new session — it is a branched projection over the SAME
 * append-only timeline (mirrors grok-bot `shared/transcript-threads.ts` +
 * `send-thread-stamping.ts`). Branched messages stay ordinary timeline entries
 * (they are journaled, rolled out, and reloaded like any message) but are
 * excluded from the main model projection and the main transcript projection,
 * so a bot's long session never splits and the main context window is never
 * polluted by branch traffic.
 *
 * Field placement: the thread metadata lives on the message's outer `metadata`
 * under the single namespace key {@link THREAD_METADATA_KEY} — never inside
 * `content`, so provider-facing message content stays clean. Projectors strip
 * the key at the model boundary and filter branched entries at the model and
 * transcript boundaries.
 *
 * All functions here are pure: they never mutate their input.
 */

import type { MessageContent } from '../types.js';
import type {
  AgentMessage,
  MessageEntry,
  MessageTimelineEntry,
} from './message-framework.js';

/** Namespace key for thread/fork metadata on an AgentMessage. */
export const THREAD_METADATA_KEY = 'threadMeta';

/**
 * Optional thread metadata carried on a message (plan 486 §2.1):
 * - `replyToId` — the id of the referenced message. For a reply (non-branch)
 *   it is a quote reference rendered in the UI; for a fork it is the thread
 *   root (or a message inside the thread) this branch descends from.
 * - `branched: true` — this message belongs to the branched layer and is
 *   excluded from the main timeline / main model context.
 */
export interface ThreadMeta {
  readonly replyToId?: string;
  readonly branched?: boolean;
}

/** Minimal node view the branch resolvers operate on (message-id space). */
export interface ThreadMessageView {
  readonly id: string;
  readonly replyToId?: string;
  /** true when the message belongs to the branched layer. */
  readonly branched: boolean;
}

const MAX_QUOTE_CHARS = 500;
const ELLIPSIS = '…';

// ─── Read helpers ────────────────────────────────────────────────────────

function asThreadMeta(value: unknown): ThreadMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const replyToId = typeof raw.replyToId === 'string' ? raw.replyToId : undefined;
  const branched = raw.branched === true;
  return replyToId === undefined && !branched ? undefined : { replyToId, branched };
}

/**
 * Reads the thread metadata off an {@link AgentMessage}. Old messages without
 * the key (the default for every pre-486 row) return undefined.
 */
export function readThreadMeta(message: unknown): ThreadMeta | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const metadata = (message as { metadata?: unknown }).metadata as
    | Record<string, unknown>
    | undefined;
  if (!metadata) return undefined;
  return asThreadMeta(metadata[THREAD_METADATA_KEY]);
}

/**
 * Returns a copy of the object without thread metadata (threadMeta field).
 * Used when compacting messages to strip thread context.
 */
export function withoutThreadMetadata<T extends Record<string, unknown>>(obj: T): T {
  if (!obj) return obj;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [THREAD_METADATA_KEY]: _, ...rest } = obj;
  return rest as T;
}

/** True when the message belongs to the branched layer. */
export function isBranchedMessage(message: unknown): boolean {
  return readThreadMeta(message)?.branched === true;
}

/** True when the message carries a reply reference (reply OR fork). */
export function isReplyMessage(message: unknown): boolean {
  return readThreadMeta(message)?.replyToId !== undefined;
}

/** True when a timeline entry is a branched-layer message. */
export function isBranchedEntry(entry: MessageTimelineEntry): boolean {
  return entry.type === 'message' && isBranchedMessage(entry.message);
}

/**
 * Merges thread metadata onto a fresh metadata record. Never mutates the input
 * message; the caller assigns the result onto a new/owned message object.
 */
export function mergeThreadMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  meta: ThreadMeta,
): Readonly<Record<string, unknown>> {
  return { ...(metadata ?? {}), [THREAD_METADATA_KEY]: { ...meta } };
}

// ─── View indexing ───────────────────────────────────────────────────────

/** Extracts the thread view of a message; non-message entries are skipped. */
export function toThreadMessageView(message: AgentMessage): ThreadMessageView | null {
  if (!message || typeof message.id !== 'string') return null;
  const meta = readThreadMeta(message);
  return {
    id: message.id,
    replyToId: meta?.replyToId,
    branched: meta?.branched === true,
  };
}

/**
 * Indexes timeline entries by message id. Control entries (compaction,
 * model_change, ...) and messages without an id are skipped.
 */
export function indexThreadViews(
  entries: readonly MessageTimelineEntry[],
): Map<string, ThreadMessageView> {
  const byId = new Map<string, ThreadMessageView>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const view = toThreadMessageView(entry.message);
    if (view) byId.set(view.id, view);
  }
  return byId;
}

// ─── Branch resolvers (aligns grok `transcript-threads.ts`) ─────────────

/**
 * Resolves the branch root of a message by walking the `replyToId` chain
 * upward until the first non-branched ancestor is found — that ancestor is
 * the root of the branch (the thread's anchor on the main line).
 *
 * Returns undefined for: unknown ids, a chain that points at a missing id,
 * an orphan branch head (branched message whose chain never reaches a
 * non-branched message), and cycles. A plain (non-branched) message resolves
 * to itself, which lets {@link branchThreadDescendants} collect the branches
 * anchored on any ordinary message.
 */
export function resolveBranchRoot(
  id: string,
  byId: ReadonlyMap<string, ThreadMessageView>,
): string | undefined {
  let currentId = id;
  let node = byId.get(currentId);
  if (!node) return undefined;

  const visited = new Set<string>();
  while (node.branched) {
    const nextId = node.replyToId;
    if (!nextId) return undefined; // orphan branch head
    if (visited.has(currentId)) return undefined; // cycle
    visited.add(currentId);
    currentId = nextId;
    node = byId.get(currentId);
    if (!node) return undefined; // dangling reference
  }
  return node.id; // first non-branched ancestor == thread root
}

/**
 * True when the chain of `descendantId` passes through `rootId` before it
 * terminates. Mirrors grok's orphan handling (agent-db.ts): when the anchor
 * (root) has been compacted away from the timeline, the descendants are still
 * reachable via their chain instead of disappearing.
 */
export function threadChainContains(
  rootId: string,
  descendantId: string,
  byId: ReadonlyMap<string, ThreadMessageView>,
): boolean {
  let currentId = descendantId;
  const visited = new Set<string>();
  for (let steps = 0; steps <= byId.size; steps += 1) {
    if (currentId === rootId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node || !node.branched) return false;
    const nextId = node.replyToId;
    if (!nextId) return false;
    currentId = nextId;
  }
  return false;
}

/**
 * All branched-layer message entries anchored on `rootId` (their resolved
 * branch root === rootId). Nested forks (a branch of a branch) still count
 * toward the same root — plan 486 §2.2 explicitly extends grok here.
 */
export function branchThreadDescendants(
  rootId: string,
  entries: readonly MessageTimelineEntry[],
): MessageEntry[] {
  const byId = indexThreadViews(entries);
  const result: MessageEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (!isBranchedMessage(entry.message)) continue;
    const messageId = entry.message.id;
    if (!messageId) continue;
    const view = byId.get(messageId);
    if (!view) continue;
    if (resolveBranchRoot(view.id, byId) === rootId) {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Per-root reply counts: Map<rootId, count> of branched messages anchored on
 * each main-line message. UI consumes this for the "N replies" badge. The
 * root itself is never counted.
 */
export function branchReplyCounts(
  entries: readonly MessageTimelineEntry[],
): Map<string, number> {
  const byId = indexThreadViews(entries);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (!isBranchedMessage(entry.message)) continue;
    const messageId = entry.message.id;
    if (!messageId) continue;
    const view = byId.get(messageId);
    if (!view) continue;
    const rootId = resolveBranchRoot(view.id, byId);
    if (rootId) counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reads one thread: the root main-line message plus its branched descendants,
 * in timeline order. When the root message itself is absent from the timeline
 * (e.g. compacted on reload) the descendants are still returned via chain
 * matching, mirroring grok `getThread`'s orphan tolerance.
 */
export function getThread(
  rootId: string,
  entries: readonly MessageTimelineEntry[],
): { root?: MessageEntry; descendants: MessageEntry[] } {
  let root: MessageEntry | undefined;
  const byId = indexThreadViews(entries);
  const descendants: MessageEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.id === rootId) {
      root = entry;
      continue;
    }
    if (!isBranchedMessage(entry.message)) continue;
    const messageId = entry.message.id;
    if (!messageId) continue;
    const view = byId.get(messageId);
    if (!view) continue;
    const anchored =
      resolveBranchRoot(view.id, byId) === rootId ||
      (root === undefined && threadChainContains(rootId, view.id, byId));
    if (anchored) descendants.push(entry);
  }
  return { root, descendants };
}

// ─── Creation rules (plan 486 §2.1 / §2.3) ──────────────────────────────

/**
 * Validates a fork/reply target: the referenced message must exist in the
 * timeline. Mirrors grok `validateAiReplyTarget` — an invalid / in-flight
 * target causes the caller to strip the reference instead of persisting a
 * dangling fork.
 */
export function validateReplyTarget(
  replyToId: string,
  knownMessageIds: ReadonlySet<string>,
): boolean {
  return knownMessageIds.has(replyToId);
}

/**
 * Resolves the thread metadata to attach to a newly created user message
 * (plan 486 §2.1 creation rules):
 * - no `replyToId`      → undefined (plain send).
 * - invalid `replyToId` → undefined (silent strip, grok `stripReplyTo`).
 * - valid + `branched`  → { replyToId, branched: true }  (fork / start-thread).
 * - valid, not branched → { replyToId }                  (quote reply).
 */
export function resolveReplyMeta(
  replyToId: string | undefined,
  branched: boolean | undefined,
  knownMessageIds: ReadonlySet<string>,
): ThreadMeta | undefined {
  if (!replyToId) return undefined;
  if (!validateReplyTarget(replyToId, knownMessageIds)) return undefined;
  return branched === true ? { replyToId, branched: true } : { replyToId };
}

// ─── Quote injection (plan 486 §2.3, mirrors grok system-prompt.ts:48) ──

/** Renders the `[In reply to <id>: "<quote>"]` prefix fed to the model. */
export function renderReplyQuotePrefix(targetId: string, quoteText: string): string {
  return `[In reply to ${targetId}: "${quoteText}"]`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown; thinking?: unknown; content?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push(b.thinking);
    else if (b.type === 'tool_result') parts.push(contentToText(b.content));
  }
  return parts.join('\n');
}

/**
 * Extracts a bounded quote from a message's content for the reply prefix.
 * Text blocks (and thinking) are concatenated, trimmed, and truncated at
 * {@link MAX_QUOTE_CHARS}.
 */
export function messageToQuoteText(
  message: AgentMessage | undefined,
  maxChars: number = MAX_QUOTE_CHARS,
): string {
  if (!message) return '';
  const content = (message as { content?: unknown }).content;
  const text = contentToText(content).replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${ELLIPSIS}`;
}

/**
 * Applies the reply quote prefix to every user message that carries a
 * `replyToId`, producing a new messages array. The prefix is rendered from
 * the referenced message's text (fetched through `lookupMessageText`).
 *
 * Idempotent: a message whose content already starts with the rendered
 * prefix for that target is left untouched, so mid-run re-projections
 * (compaction, model switch) never double-inject. Messages without a
 * `replyToId` are returned unchanged.
 */
export function applyReplyQuoteContext(
  messages: readonly AgentMessage[],
  lookupMessageText: (id: string) => string,
): readonly AgentMessage[] {
  let changed = false;
  const result: AgentMessage[] = messages.map((message) => {
    const meta = readThreadMeta(message);
    const targetId = meta?.replyToId;
    if (!targetId || message.role !== 'user') return message;
    const quoteText = lookupMessageText(targetId);
    if (!quoteText) return message;
    const prefix = renderReplyQuotePrefix(targetId, quoteText);

    if (typeof message.content === 'string') {
      if (message.content.startsWith(`[In reply to ${targetId}:`)) return message;
      changed = true;
      return { ...(message as object), content: `${prefix}\n\n${message.content}` } as AgentMessage;
    }
    if (Array.isArray(message.content)) {
      const head = message.content[0];
      if (
        head &&
        typeof head === 'object' &&
        (head as { type?: string }).type === 'text' &&
        typeof (head as { text?: unknown }).text === 'string' &&
        (head as { text: string }).text.startsWith(`[In reply to ${targetId}:`)
      ) {
        return message;
      }
      changed = true;
      return {
        ...(message as object),
        content: [
          { type: 'text', text: prefix } as MessageContent,
          ...message.content,
        ],
      } as AgentMessage;
    }
    return message;
  });
  return changed ? result : messages;
}

/** Known message id set helper for creation-rule consumers. */
export function collectMessageIds(
  entries: readonly MessageTimelineEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'message' && typeof entry.message.id === 'string') {
      ids.add(entry.message.id);
    }
  }
  return ids;
}
