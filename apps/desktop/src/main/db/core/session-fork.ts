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

import { deriveSessionForkSeed } from '@duya/agent-protocol/session-fork';
import type { MessageLog, NewEvent, TimelineEntryRow } from './message-log';
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
  const derived = deriveSessionForkSeed(input);
  if (!derived.ok) {
    return { ok: false, reason: derived.reason, seedEvents: [], idMap: new Map() };
  }
  const seedEvents: NewEvent[] = derived.entries.map((entry) => ({
    id: entry.id,
    sessionId: input.newSessionId,
    turnId: null,
    payload: entry,
    createdAt: entry.createdAt,
  }));
  return { ok: true, seedEvents, idMap: new Map(derived.idMap) };
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
  | { ok: false; reason: 'source_not_found' | 'message_not_found' | 'source_archived'; seedCount: 0 };

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

  // 1b. Plan 582 (G3): refuse to fork out of an archived session.
  //
  // Archiving relocates the rollout to `archived/<date>/…` and records it in
  // `archived_path`. Forgetting that here is worse than a cosmetic bug: the
  // timeline read below goes through `MessageLog.repairedProject`, whose
  // drift recovery (`findRolloutFileBySessionId`) will happily "find" the
  // archived file and `adoptRolloutPath` it — silently resurrecting an
  // archived session into the active roster as a side effect of a fork.
  //
  // codex gates the same operation: after commit d944ce83a2 the CLI refuses
  // to resume or fork an archived session and offers to unarchive first.
  if (source.status === 'archived') {
    return { ok: false, reason: 'source_archived', seedCount: 0 };
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
