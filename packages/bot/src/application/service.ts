/**
 * service.ts — the Bot identity application service (framework plan S1,
 * moved to `@duya/bot` in S2).
 *
 * One application interface for bot create / update / read, constructed with
 * two port sets: the standalone Host's TOML file backend and the Desktop
 * config store backend. S1's acceptance is decided here:
 *
 *   - Desktop/TUI query the same Bot: both bridges answer from this service,
 *     whose canonical view merges profile.json (runtime identity) over the
 *     config entry (declared identity).
 *   - create/update revision conflicts are REJECTED (`bot_revision_conflict`
 *     with the stored and expected numbers in `details`), and errors are
 *     thrown as `BotServiceError`, never swallowed into a soft failure.
 *   - retried creates are deduplicated by requestId through the identity
 *     journal, across process crashes.
 *   - pending intents from a crash between the journal append and the config
 *     write are rolled forward by `repair()`, which runs at construction —
 *     the next writer completes what the last writer started.
 *
 * What this service deliberately does NOT do: schedule anything. The
 * Desktop wake dispatcher remains the only scheduler (the plan's "旧 Desktop
 * 调度作为过渡 adapter"); S3 owns durable wake admission. Adding a second
 * scheduler here would be the exact regression S0's boundary gate exists to
 * prevent.
 *
 * Field semantics come from the domain rules (`buildUpsertedAgent`) so the
 * facade cannot drift from the legacy writers on what an update preserves
 * (provider / reasoning / prompt / tools) — the facade is a new caller of the
 * same rules, not a second set of them.
 *
 * The one S2 change: the id-minting collision suffix is injected
 * (`randomSuffix`) because this package performs zero IO. Backends that care
 * pass their crypto implementation; the fallback below is a plain
 * Math.random suffix with the same 6-hex shape — uniqueness, not secrecy, is
 * the requirement.
 */

import {
  allocateBotId,
  applyIdentityPatch,
  buildUpsertedAgent,
  canonicalBotRecord,
  isSoftDeletedConfigAgent,
  slugifyBotIdFromName,
} from '../domain/rules.js';
import { BotServiceError } from '../domain/errors.js';
import type { BotIdentityEntry, BotUpdatePatch } from '../domain/identity.js';
import type {
  BotIdentityJournalPort,
  BotIdentityStorePort,
  BotProfilePort,
} from '../ports/ports.js';
import type {
  BotCommandReceipt,
  BotRecord,
  CreateBotCommand,
  UpdateBotCommand,
} from '@duya/agent-protocol/bot-api';

export interface BotServicePorts {
  config: BotIdentityStorePort;
  profile: BotProfilePort;
  journal: BotIdentityJournalPort;
  logger?: {
    warn?(message: string, context?: Record<string, unknown>): void;
    info?(message: string, context?: Record<string, unknown>): void;
  } | undefined;
  /**
   * One collision suffix per call for id minting (the Host passes its
   * node:crypto implementation). Optional: the default keeps the same
   * 6-hex-char shape as the S1 crypto suffix without importing node.
   */
  randomSuffix?: (() => string) | undefined;
}

export interface BotRepairConflict {
  seq: number;
  id: string;
  reason: 'create-target-exists-with-different-name';
}

export interface BotRepairReport {
  /** Intents rolled forward or confirmed already applied this run. */
  repaired: number;
  /** Intents left pending on purpose — a human decides, the journal keeps evidence. */
  conflicts: BotRepairConflict[];
  corruptJournalLines: number;
  /** True when the backend wrote a pre-repair snapshot. */
  snapshotted: boolean;
}

export interface BotService {
  createBot(command: CreateBotCommand): Promise<BotCommandReceipt>;
  updateBot(command: UpdateBotCommand): Promise<BotCommandReceipt>;
  getBot(id: string): Promise<BotRecord | null>;
  listBots(): Promise<BotRecord[]>;
  repair(): Promise<BotRepairReport>;
}

/** 6 lowercase hex chars — always inside the bot-id charset (uniqueness only). */
function defaultRandomSuffix(): string {
  return Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
}

export function createBotService(ports: BotServicePorts): BotService {
  const { config, profile, journal, logger, randomSuffix } = ports;

  /** Roll forward (or confirm) every pending intent. See the header. */
  async function repair(): Promise<BotRepairReport> {
    const load = journal.report();
    const conflicts: BotRepairConflict[] = [];
    if (load.pending.length === 0) {
      return { repaired: 0, conflicts, corruptJournalLines: load.corruptLines, snapshotted: false };
    }

    let snapshotted = false;
    if (config.snapshotForRepair) {
      try {
        snapshotted = (await config.snapshotForRepair()) !== false;
      } catch (error) {
        // A failed backup must not block the repair; it is reported instead.
        logger?.warn?.('bot repair snapshot failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const agents = await config.readAgents();
    let dirty = false;
    let repaired = 0;

    for (const intent of load.pending) {
      if (intent.kind === 'create') {
        const existing = agents[intent.id];
        if (existing === undefined) {
          agents[intent.id] = intent.entry;
          dirty = true;
          await seedQuietly(intent.id, intent.entry);
          journal.markApplied(intent.seq);
          repaired += 1;
        } else if ((existing.name ?? intent.id) === (intent.entry.name ?? intent.id)) {
          // Crash between the config write and the marker: already applied.
          journal.markApplied(intent.seq);
          repaired += 1;
        } else {
          // A different entry owns the id — never clobber, keep the evidence.
          conflicts.push({ seq: intent.seq, id: intent.id, reason: 'create-target-exists-with-different-name' });
        }
        continue;
      }

      const existing = agents[intent.id];
      if (existing === undefined || isSoftDeletedConfigAgent(existing)) {
        // The update's target died between intent and crash; the intent is
        // moot. Marking it applied (rather than leaving it pending forever)
        // is the honest state: nothing it wanted to change still exists.
        journal.markApplied(intent.seq);
        repaired += 1;
        continue;
      }
      if ((existing.revision ?? 0) >= intent.nextRevision) {
        journal.markApplied(intent.seq);
        repaired += 1;
        continue;
      }
      agents[intent.id] = applyIdentityPatch(existing, intent.patch, intent.nextRevision);
      dirty = true;
      await patchProfileQuietly(intent.id, intent.patch);
      journal.markApplied(intent.seq);
      repaired += 1;
    }

    if (dirty) await config.writeAgents(agents);
    if (repaired > 0 || conflicts.length > 0) {
      logger?.info?.('bot identity journal repaired', { repaired, conflicts: conflicts.length });
    }
    return { repaired, conflicts, corruptJournalLines: load.corruptLines, snapshotted };
  }

  /**
   * Sync an owner identity patch into the runtime profile, best-effort.
   * Only non-empty trimmed fields change (the legacy patch semantics); a bot
   * without a profile keeps the config entry as its identity — the facade
   * does not create runtime profiles for patches, seeding owns that.
   */
  async function patchProfileQuietly(id: string, patch: BotUpdatePatch): Promise<void> {
    try {
      const current = await profile.readProfile(id);
      if (current === null) return;
      const nextProfile = {
        ...current,
        ...(patch.name !== undefined && patch.name.trim() ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined && patch.description.trim()
          ? { description: patch.description.trim() }
          : {}),
      };
      await profile.writeProfile(id, nextProfile);
    } catch (error) {
      logger?.warn?.('bot profile patch failed', {
        botId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Best-effort profile seeding that never fails the caller. */
  async function seedQuietly(id: string, entry: BotIdentityEntry): Promise<void> {
    try {
      await profile.seedProfile(id, entry);
    } catch (error) {
      logger?.warn?.('bot profile seeding failed', {
        botId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function createBot(command: CreateBotCommand): Promise<BotCommandReceipt> {
    const name = command.name.trim();
    if (!name) throw new BotServiceError('bot_invalid_name', 'bot name is required');

    if (command.requestId) {
      const receipt = journal.lookupCreate(command.requestId);
      if (receipt !== null) return { ...receipt, deduplicated: true };
    }

    const agents = await config.readAgents();
    const taken = await config.takenIds(Object.keys(agents));
    const id = allocateBotId(
      slugifyBotIdFromName(name),
      taken,
      randomSuffix ?? defaultRandomSuffix,
    );
    const entry: BotIdentityEntry = {
      ...buildUpsertedAgent(undefined, {
        name,
        description: command.description?.trim() || undefined,
      }),
      revision: 1,
    };

    const intent = journal.appendCreate({ requestId: command.requestId ?? null, id, entry, nextRevision: 1 });
    await config.writeAgents({ ...agents, [id]: entry });
    await seedQuietly(id, entry);
    journal.markApplied(intent.seq);

    logger?.info?.('bot created', { botId: id });
    return { id, name: entry.name ?? id, revision: 1 };
  }

  async function updateBot(command: UpdateBotCommand): Promise<BotCommandReceipt> {
    const id = command.id.trim();
    if (!id) throw new BotServiceError('bot_not_found', 'bot id is required');

    const agents = await config.readAgents();
    const existing = agents[id];
    if (existing === undefined) {
      throw new BotServiceError('bot_not_found', `bot '${id}' not found`);
    }
    if (isSoftDeletedConfigAgent(existing)) {
      throw new BotServiceError('bot_soft_deleted', `bot '${id}' is soft-deleted; restore or purge it first`);
    }

    const storedRevision = existing.revision ?? 0;
    if (command.expectedRevision !== undefined && command.expectedRevision !== storedRevision) {
      throw new BotServiceError(
        'bot_revision_conflict',
        `bot '${id}' is at revision ${storedRevision}, expected ${command.expectedRevision}`,
        { storedRevision, expectedRevision: command.expectedRevision },
      );
    }

    const patch: BotUpdatePatch = { name: command.name, description: command.description };
    const nextRevision = storedRevision + 1;
    const intent = journal.appendUpdate({ id, patch, nextRevision });
    const next = applyIdentityPatch(existing, patch, nextRevision);
    await config.writeAgents({ ...agents, [id]: next });
    // One intent covers BOTH identity stores: config entry + runtime
    // profile. A crash between them leaves a pending intent whose repair
    // completes the profile too — the canonical view never splits.
    await patchProfileQuietly(id, patch);
    journal.markApplied(intent.seq);

    logger?.info?.('bot updated', { botId: id, revision: nextRevision });
    return { id, name: next.name ?? id, revision: nextRevision };
  }

  async function getBot(id: string): Promise<BotRecord | null> {
    const agents = await config.readAgents();
    return canonicalBotRecord(id, agents[id], await profile.readProfile(id));
  }

  async function listBots(): Promise<BotRecord[]> {
    const agents = await config.readAgents();
    const records: BotRecord[] = [];
    for (const [id, entry] of Object.entries(agents)) {
      if (isSoftDeletedConfigAgent(entry)) continue;
      const record = canonicalBotRecord(id, entry, await profile.readProfile(id));
      if (record) records.push(record);
    }
    records.sort((a, b) => a.id.localeCompare(b.id));
    return records;
  }

  return { createBot, updateBot, getBot, listBots, repair };
}

/**
 * The generic open for backends that assemble their own ports (the Desktop
 * config store): create the service AND roll the journal forward before the
 * first command. Construction alone cannot repair (repair is async); every
 * caller that opens a service for a command goes through here so a crash
 * between journal append and config write is completed by the next writer,
 * not by luck.
 */
export async function openBotService(ports: BotServicePorts): Promise<BotService> {
  const service = createBotService(ports);
  await service.repair();
  return service;
}
