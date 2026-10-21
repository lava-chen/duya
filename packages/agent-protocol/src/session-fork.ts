import { THREAD_METADATA_KEY, type MessageEntry } from './message-timeline.js';
import type { DurableTimelineEntry } from './rollout-events.js';

export interface SessionForkTimelineRow {
  readonly entry: DurableTimelineEntry;
}

export interface SessionForkSeedInput {
  /** The source's projected, repaired timeline in order. */
  readonly timeline: readonly SessionForkTimelineRow[];
  /** Seed through this message, inclusive. */
  readonly throughMessageId: string;
  readonly newSessionId: string;
  readonly idPrefix?: string;
}

export type SessionForkSeedResult =
  | {
      readonly ok: true;
      readonly entries: readonly MessageEntry[];
      readonly idMap: readonly (readonly [string, string])[];
    }
  | {
      readonly ok: false;
      readonly reason: 'message_not_found';
      readonly entries: readonly [];
      readonly idMap: readonly [];
    };

/** Pure fork projection shared by Host and the legacy Desktop adapter. */
export function deriveSessionForkSeed(input: SessionForkSeedInput): SessionForkSeedResult {
  let targetIndex = -1;
  for (let index = 0; index < input.timeline.length; index += 1) {
    const entry = input.timeline[index]?.entry;
    if (entry?.type === 'message' && entry.id === input.throughMessageId) {
      targetIndex = index;
      break;
    }
  }

  if (targetIndex < 0) {
    return { ok: false, reason: 'message_not_found', entries: [], idMap: [] };
  }

  const seeded = input.timeline
    .slice(0, targetIndex + 1)
    .flatMap(({ entry }) => entry.type === 'message' ? [entry] : []);
  const prefix = input.idPrefix ?? 'fork';
  const ids = new Map<string, string>();
  for (const entry of seeded) {
    ids.set(entry.id, `${prefix}:${input.newSessionId}:${entry.id}`);
  }

  const entries: MessageEntry[] = [];
  for (const entry of seeded) {
    const copy = JSON.parse(JSON.stringify(entry)) as MessageEntry;
    const newId = ids.get(entry.id);
    if (newId === undefined) continue;

    copy.id = newId;
    if (typeof copy.parentId === 'string') {
      copy.parentId = ids.get(copy.parentId) ?? copy.parentId;
    }
    if (typeof copy.message.id === 'string') copy.message.id = newId;
    remapThreadReplyReference(copy.message, ids);
    entries.push(copy);
  }

  return { ok: true, entries, idMap: Array.from(ids.entries()) };
}

function remapThreadReplyReference(
  message: MessageEntry['message'],
  ids: ReadonlyMap<string, string>,
): void {
  if (!message || typeof message !== 'object') return;
  const metadata = (message as { metadata?: unknown }).metadata as Record<string, unknown> | undefined;
  if (!metadata) return;
  const threadMeta = metadata[THREAD_METADATA_KEY];
  if (!threadMeta || typeof threadMeta !== 'object' || Array.isArray(threadMeta)) return;
  const replyToId = (threadMeta as Record<string, unknown>).replyToId;
  if (typeof replyToId !== 'string') return;
  const mapped = ids.get(replyToId);
  if (mapped !== undefined) (threadMeta as Record<string, unknown>).replyToId = mapped;
}
