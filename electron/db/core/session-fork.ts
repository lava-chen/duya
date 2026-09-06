/**
 * Session fork seed derivation (plan 506, Track B1).
 *
 * A session fork starts a NEW session whose initial rollout content is the
 * effective message timeline of a SOURCE session, cut at a chosen message
 * (inclusive). This module is the pure derivation step: it takes the
 * already-projected (`applyRebases`) + repaired
 * (`repairInterruptedToolCalls`) message-only timeline and produces
 * `NewEvent[]` rows ready for `MessageLog.appendBatch` on the new session.
 *
 * CRITICAL constraint: `message_index.id` is a GLOBAL primary key (not
 * composite with session_id), so seed messages MUST NOT reuse the source
 * session's ids verbatim — `INSERT OR IGNORE` would silently drop every
 * colliding row and leave the fork session empty. Every seeded message gets
 * a fresh deterministic id `<prefix>:<newSessionId>:<oldId>`, and every
 * identity field (entry.id, entry.parentId, inner message.id, and the
 * plan-486 threadMeta.replyToId reference) is remapped onto the new id space.
 *
 * The function is pure: no fs, no DB, no Electron imports, no projection or
 * repair logic (the caller owns that pipeline). It never mutates the input
 * timeline — payloads are fresh JSON round-trip copies, which is exactly the
 * rollout wire format the JSONL file persists anyway.
 */

import { THREAD_METADATA_KEY, type MessageEntry } from '@duya/agent/message';
import type { NewEvent, TimelineEntryRow } from './message-log';
import { rolloutLineTimestamp } from './rollout-events';

export interface ForkSeedInput {
  /** Projected + repaired + message-only timeline of the SOURCE session, in order. */
  timeline: TimelineEntryRow[];
  /** The message id (entry.id) the fork point targets — seed includes everything up to and including it. */
  throughMessageId: string;
  /** The NEW session id the seed events will be appended to. */
  newSessionId: string;
  /** Optional prefix for minted ids; default 'fork'. */
  idPrefix?: string;
}

export interface ForkSeedResult {
  ok: boolean;
  reason?: 'message_not_found';
  /** Seed events ready for MessageLog.appendBatch (payloads are fresh MessageEntry copies with new ids). */
  seedEvents: NewEvent[];
  /** oldMessageId -> newMessageId map (for lineage/debug). */
  idMap: Map<string, string>;
}

export function deriveForkSeed(input: ForkSeedInput): ForkSeedResult {
  // 1. Locate the fork target among MESSAGE entries only. The input timeline
  //    is message-only per contract, but a rollout event sneaking in must
  //    never satisfy the lookup — events carry ids too.
  let targetIndex = -1;
  for (let i = 0; i < input.timeline.length; i++) {
    const entry = input.timeline[i].entry;
    if (entry.type === 'message' && entry.id === input.throughMessageId) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) {
    return {
      ok: false,
      reason: 'message_not_found',
      seedEvents: [],
      idMap: new Map<string, string>(),
    };
  }

  // 2. Collect the seeded prefix: every message entry from index 0 through
  //    the target index, in timeline order. Non-message rows are skipped
  //    defensively.
  const seeded: MessageEntry[] = [];
  for (let i = 0; i <= targetIndex; i++) {
    const entry = input.timeline[i].entry;
    if (entry.type === 'message') seeded.push(entry);
  }

  // 3. Mint the fresh id space BEFORE copying so cross-references resolve in
  //    any direction (a replyToId pointing at a later seeded message remaps
  //    too). Deterministic: the same fork always produces the same ids.
  const prefix = input.idPrefix ?? 'fork';
  const idMap = new Map<string, string>();
  for (const entry of seeded) {
    idMap.set(entry.id, `${prefix}:${input.newSessionId}:${entry.id}`);
  }

  // 4. Deep-copy each entry, remap every identity field, and emit a NewEvent.
  //    JSON round-trip = the exact shape that survives a rollout-file write.
  const seedEvents: NewEvent[] = [];
  for (const entry of seeded) {
    const copy = JSON.parse(JSON.stringify(entry)) as MessageEntry;
    const newId = idMap.get(entry.id);
    if (newId === undefined) continue; // unreachable: every seeded id is mapped

    copy.id = newId;
    // Parent chain: remap when the parent was seeded. For a contiguous
    // prefix a parent outside the seed set cannot exist, but if one does
    // (legacy data), it is left verbatim rather than dangling-rewritten.
    if (typeof copy.parentId === 'string') {
      const mappedParent = idMap.get(copy.parentId);
      if (mappedParent !== undefined) copy.parentId = mappedParent;
    }
    // Inner message identity: every AgentMessage variant carries an `id`
    // (optional on the provider Message, required on the custom roles).
    // Set it to the same new id so entry and message stay in lockstep.
    if (typeof copy.message.id === 'string') {
      copy.message.id = newId;
    }
    remapThreadReplyReference(copy.message, idMap);

    seedEvents.push({
      id: newId,
      sessionId: input.newSessionId,
      turnId: null,
      payload: copy,
      createdAt:
        typeof entry.createdAt === 'number'
          ? entry.createdAt
          : rolloutLineTimestamp(copy),
    });
  }

  return { ok: true, seedEvents, idMap };
}

/**
 * Rewrite `metadata.threadMeta.replyToId` (plan 486 threads) onto the new id
 * space when it references a seeded message. References outside the seed set
 * (dangling ids, messages past the fork point) are left verbatim so lineage
 * information survives. `message` must be a private deep copy owned by the
 * caller — this helper mutates it in place.
 */
function remapThreadReplyReference(
  message: MessageEntry['message'],
  idMap: Map<string, string>,
): void {
  if (!message || typeof message !== 'object') return;
  // Structural cast mirrors readThreadMeta in @duya/agent/message — some
  // AgentMessage role variants do not declare `metadata`, so the union
  // cannot be accessed directly.
  const metadata = (message as { metadata?: unknown }).metadata as
    | Record<string, unknown>
    | undefined;
  if (!metadata) return;

  const threadMeta: unknown = metadata[THREAD_METADATA_KEY];
  if (!threadMeta || typeof threadMeta !== 'object' || Array.isArray(threadMeta)) {
    return;
  }
  const raw = threadMeta as Record<string, unknown>;
  if (typeof raw.replyToId !== 'string') return;

  const mapped = idMap.get(raw.replyToId);
  if (mapped === undefined) return; // outside the seed set — keep verbatim
  raw.replyToId = mapped;
}
