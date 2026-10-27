/**
 * ports.ts — the seams the Bot application service owns (framework plan S2;
 * moved from the Host's `bot/ports.ts`, types renamed to the domain package's
 * vocabulary).
 *
 * The service (`application/service.ts`) holds the use cases; everything it
 * touches of the outside world is a port here. Two adapter sets exist on
 * purpose and only two: the standalone Host (TOML file + agent tree under the
 * data root, `packages/host/src/bot/`) and the Desktop main process (its
 * in-memory config store, `apps/desktop/src/main/config/bot-application.ts`).
 * That is the whole point of S1 — one application interface, two storage
 * backends, so Desktop and TUI go through the SAME create / update / read
 * semantics instead of two hand-rolled writers drifting apart on revision
 * and idempotency.
 *
 * The port surface is intentionally narrow (the plan's §5 rule: no god
 * repository). Reading the agents table and writing it back whole mirrors
 * what both writers already do atomically today; `takenIds` is the id
 * minting view (config keys + on-disk trees + tombstones) so the service can
 * never allocate a colliding bot id; the profile port is read + seed, not
 * read + write, because runtime identity (model self-edits) keeps its
 * existing write path and the facade only seeds on first creation.
 */

import type { BotCommandReceipt } from '@duya/agent-protocol/bot-api';
import type { BotIdentityEntry, BotUpdatePatch } from '../domain/identity.js';
import type { BotProfile } from '../domain/profile.js';
import type {
  BotCreateIntent,
  BotUpdateIntent,
  JournalLoadReport,
} from '../journal/journal.js';

/**
 * The `[agents.<id>]` table the service reads and replaces whole.
 *
 * `writeAgents` must be atomic per the backend's own discipline (the Host
 * writes the TOML file atomically; the Desktop writes through its config
 * store, which owns that file). The service never mutates other tables.
 */
export interface BotIdentityStorePort {
  readAgents(): Promise<Record<string, BotIdentityEntry>>;
  writeAgents(next: Record<string, BotIdentityEntry>): Promise<void>;
  /**
   * Every bot id that must be treated as taken: the config keys handed in
   * plus the backend's on-disk view (agent trees, soft-delete tombstones).
   */
  takenIds(configKeys: string[]): Promise<Set<string>>;
  /**
   * One best-effort backup before a repair rolls a pending intent forward.
   * Optional because the Desktop store owns its own durability; the Host
   * copies `config.toml` next to itself. The repair report says whether a
   * snapshot ran, so the absence of one is visible, not silent.
   */
  snapshotForRepair?(): Promise<boolean | void>;
}

/** profile.json access: seed-once on create, read + owner-patch sync. */
export interface BotProfilePort {
  /** Seeds the profile when missing. Returns false when it already exists or
   * the id is not a safe bot id. Must never throw for a locked file — log via
   * the service logger instead (a seeding failure must not fail the write). */
  seedProfile(id: string, entry: BotIdentityEntry): Promise<boolean>;
  /** The runtime identity, or null when no profile exists. */
  readProfile(id: string): Promise<BotProfile | null>;
  /** Atomic whole-profile write (the owner side of identity; the model's
   * update_state path keeps its own writer outside the facade). */
  writeProfile(id: string, profile: BotProfile): Promise<void>;
}

/**
 * The durable intent half of the identity contract. Implementations own
 * persistence (the Host appends JSONL; the in-memory implementation keeps
 * nothing on disk) and share the record shapes and semantics of
 * `BotIdentityJournalState`.
 */
export interface BotIdentityJournalPort {
  /** The load report — what repair has to work with. */
  report(): JournalLoadReport;
  /** A completed create's receipt by requestId, or null. */
  lookupCreate(requestId: string): BotCommandReceipt | null;
  /** Journal a create intent BEFORE the config write; persist the record. */
  appendCreate(input: {
    requestId: string | null;
    id: string;
    entry: BotIdentityEntry;
    nextRevision: number;
  }): BotCreateIntent;
  /** Journal an update intent BEFORE the config write; persist the record. */
  appendUpdate(input: {
    id: string;
    patch: BotUpdatePatch;
    nextRevision: number;
  }): BotUpdateIntent;
  /** Close an intent AFTER the config write (and profile sync) complete. */
  markApplied(seq: number): void;
}
