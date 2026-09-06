/**
 * Session fork seed derivation + orchestration + lineage (plan 506, Track B).
 *
 * A session fork starts a NEW session whose initial rollout content is the
 * effective message timeline of a SOURCE session, cut at a chosen message
 * (inclusive). `deriveForkSeed` is the pure derivation step: it takes the
 * already-projected (`applyRebases`) + repaired
 * (`repairInterruptedToolCalls`) message-only timeline and produces
 * `NewEvent[]` rows ready for `MessageLog.appendBatch` on the new session.
 * `forkSession` orchestrates the whole fork against injected store handles
 * (B1), and the lineage helpers below walk spawn edges (B2).
 *
 * CRITICAL constraint: `message_index.id` is a GLOBAL primary key (not
 * composite with session_id), so seed messages MUST NOT reuse the source
 * session's ids verbatim — `INSERT OR IGNORE` would silently drop every
 * colliding row and leave the fork session empty. Every seeded message gets
 * a fresh deterministic id `<prefix>:<newSessionId>:<oldId>`, and every
 * identity field (entry.id, entry.parentId, inner message.id, and the
 * plan-486 threadMeta.replyToId reference) is remapped onto the new id space.
 *
 * Purity: no fs, no DB connections, no Electron imports, and no projection
 * or repair logic (the caller owns that pipeline). `forkSession` touches
 * stores only through the `ForkSessionDeps` handles the caller injects —
 * all store imports here are type-only, so this module never creates a
 * value-level dependency cycle with the store modules. The derivation never
 * mutates the input timeline — payloads are fresh JSON round-trip copies,
 * which is exactly the rollout wire format the JSONL file persists anyway.
 */

import { THREAD_METADATA_KEY, type MessageEntry } from '@duya/agent/message';
import type { MessageLog, NewEvent, TimelineEntryRow } from './message-log';
import { rolloutLineTimestamp } from './rollout-events';
import type { SessionStore } from './session-store';
import type { SpawnEdgeStore } from './stores';

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

// ─── forkSession orchestration (plan 506, Track B1) ───

/**
 * Store handles `forkSession` needs. Injected as narrow `Pick`s so the
 * orchestrator is testable against real stores without dragging in the
 * full aggregate surface, and so this module keeps no value-level import
 * of the store modules.
 */
export interface ForkSessionDeps {
  messageLog: Pick<MessageLog, 'repairedProject' | 'appendBatch'>;
  sessions: Pick<SessionStore, 'create' | 'get'>;
  spawnEdges: Pick<SpawnEdgeStore, 'record'>;
}

export interface ForkSessionInput {
  sourceSessionId: string;
  throughMessageId: string;
  /** Caller-minted fresh id for the new session (module stays pure — no uuid generation here). */
  newSessionId: string;
  title?: string;
}

export type ForkSessionResult =
  | { ok: true; sessionId: string; seedCount: number; idMap: Map<string, string> }
  | { ok: false; reason: 'source_not_found' | 'message_not_found'; seedCount: 0 };

/**
 * Fork a session: create a NEW session whose rollout starts as a copy of
 * the source session's effective timeline up to and including
 * `throughMessageId`, then record the lineage edge. Synchronous throughout
 * (better-sqlite3 is sync). Failure modes are checked BEFORE any write, so
 * a failed fork leaves no partial session row, rollout file, or edge behind.
 *
 * Order matters: the session row is created BEFORE `appendBatch` so the row
 * exists when `MessageLog.getOrCreateRolloutPath` writes back
 * `sessions.rollout_path` on the fork's first append.
 */
export function forkSession(
  deps: ForkSessionDeps,
  input: ForkSessionInput,
): ForkSessionResult {
  // 1. The source session must exist.
  const source = deps.sessions.get(input.sourceSessionId);
  if (!source) {
    return { ok: false, reason: 'source_not_found', seedCount: 0 };
  }

  // 2. Effective timeline of the source: projected (rebase-applied),
  //    repaired, message-only — exactly the input contract deriveForkSeed
  //    documents.
  const timeline = deps.messageLog.repairedProject(input.sourceSessionId);

  // 3. Pure seed derivation; a target id absent from the message timeline
  //    (or present only on a non-message row) is a message_not_found.
  const seed = deriveForkSeed({
    timeline,
    throughMessageId: input.throughMessageId,
    newSessionId: input.newSessionId,
  });
  if (!seed.ok) {
    return { ok: false, reason: 'message_not_found', seedCount: 0 };
  }

  // 4. Create the new session row, mirroring the source's configuration.
  //    parentSessionId carries the lineage on the session row itself (B2).
  deps.sessions.create({
    id: input.newSessionId,
    title: input.title ?? `${source.title} (fork)`,
    workingDirectory: source.workingDirectory,
    projectName: source.projectName,
    model: source.model,
    providerId: source.providerId,
    mode: source.mode,
    permissionMode: source.permissionMode,
    agentProfileId: source.agentProfileId,
    agentType: source.agentType ?? 'main',
    agentName: source.agentName,
    parentSessionId: input.sourceSessionId,
    status: 'active',
  });

  // 5. Seed the new session's rollout (appendBatch assigns fresh seqs).
  deps.messageLog.appendBatch(seed.seedEvents);

  // 6. Record the spawn edge — the lineage truth source (plan 332).
  deps.spawnEdges.record({
    parentSessionId: input.sourceSessionId,
    childSessionId: input.newSessionId,
    spawnTurnId: null,
    spawnReason: `fork at message ${input.throughMessageId}`,
    spawnType: 'fork',
  });

  return {
    ok: true,
    sessionId: input.newSessionId,
    seedCount: seed.seedEvents.length,
    idMap: seed.idMap,
  };
}

// ─── Lineage helpers (plan 506, Track B2) ───

/**
 * Minimal structural edge shape so the helpers stay decoupled from the
 * store. `SpawnEdge` (stores.ts) is structurally assignable to this, so
 * the helpers accept live store output via plain structural typing.
 */
export interface LineageEdge {
  parentSessionId: string;
  childSessionId: string;
  spawnType: string;
  spawnedAt: number;
}

/**
 * A session's lineage summary. `null` fields mark a root session (no
 * incoming spawn edge in the provided edge set).
 */
export interface LineageNode {
  sessionId: string;
  parentSessionId: string | null;
  spawnType: string | null;
  spawnedAt: number | null;
}

/**
 * Walk the ancestor chain from `sessionId` up to the root, nearest ancestor
 * first. A node carries ITS OWN spawn metadata (from the edge whose child
 * it is); the root ancestor has no incoming edge, hence null fields.
 * Cycle-safe: a malformed edge loop terminates instead of hanging. Returns
 * [] when the session has no parent edge.
 */
export function ancestorChain(
  edges: readonly LineageEdge[],
  sessionId: string,
): LineageNode[] {
  const byChild = new Map<string, LineageEdge>();
  for (const edge of edges) byChild.set(edge.childSessionId, edge);

  const chain: LineageNode[] = [];
  const visited = new Set<string>([sessionId]);
  let childId = sessionId;
  // Walk edge-by-edge upward. `visited` grows with every accepted ancestor,
  // so a loop (A→B→A) hits the guard and terminates.
  for (;;) {
    const edge = byChild.get(childId);
    if (!edge) break;
    const parentId = edge.parentSessionId;
    if (visited.has(parentId)) break; // cycle guard
    visited.add(parentId);
    const parentEdge = byChild.get(parentId);
    chain.push(parentEdge ? lineageNodeOf(parentEdge) : rootLineageNode(parentId));
    childId = parentId;
  }
  return chain;
}

/**
 * All direct children of `sessionId`, oldest first. Optionally filter by
 * spawnType (default undefined = all edge types).
 */
export function childrenOf(
  edges: readonly LineageEdge[],
  sessionId: string,
  spawnType?: string,
): LineageNode[] {
  return edges
    .filter(
      (edge) =>
        edge.parentSessionId === sessionId &&
        (spawnType === undefined || edge.spawnType === spawnType),
    )
    .sort((a, b) => a.spawnedAt - b.spawnedAt)
    .map(lineageNodeOf);
}

/** Node view of an edge: describes the edge's CHILD session. */
function lineageNodeOf(edge: LineageEdge): LineageNode {
  return {
    sessionId: edge.childSessionId,
    parentSessionId: edge.parentSessionId,
    spawnType: edge.spawnType,
    spawnedAt: edge.spawnedAt,
  };
}

/** Node view of a session with no incoming edge in the provided set. */
function rootLineageNode(sessionId: string): LineageNode {
  return { sessionId, parentSessionId: null, spawnType: null, spawnedAt: null };
}
