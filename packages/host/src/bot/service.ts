/**
 * service.ts — the Host file backend of the Bot identity service (framework
 * plan S2).
 *
 * The use cases and their semantics moved to `@duya/bot` (S2): repair, the
 * revision contract and the requestId dedup are that package's
 * `createBotService`, unchanged from S1. What remains here is the Host side
 * of the seam — the file adapters over one data root (`config.toml` + the
 * `agents/` tree) and the crypto id-minting suffix this package is allowed to
 * own — plus the S1 re-exports, so every existing importer keeps one path.
 *
 * Constructed per bridge call — the journal is small and the repair pass is a
 * no-op scan when nothing is pending.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';
import { createBotService, openBotService as openDomainBotService } from '@duya/bot';
import type {
  BotRepairConflict,
  BotRepairReport,
  BotService,
  BotServicePorts,
} from '@duya/bot';
import { getDuyaAgentsRoot } from '../config-agents/bot-paths.js';
import { createTomlConfigStore } from './toml-config-store.js';
import { createFsProfilePort } from './fs-profile-store.js';
import { BotIdentityJournal } from './file-journal.js';

// S1 names that live in @duya/bot now; re-exported so the barrel (and every
// S1 consumer, including the Desktop's `@duya/host/bot` imports) keeps one
// import path and zero behavior change.
export { BotServiceError, applyIdentityPatch, createBotService } from '@duya/bot';
export type {
  BotRepairConflict,
  BotRepairReport,
  BotService,
  BotServicePorts,
} from '@duya/bot';

/** 6 lowercase hex chars — always inside the bot-id charset (S1 semantics). */
function cryptoRandomSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * The standalone-Host port set over one data root: `config.toml` + the
 * `agents/` tree, with `createBotService`'s constructor repair as the
 * crash-recovery entry point.
 */
export function createHostBotService(
  root?: string,
  logger?: BotServicePorts['logger'],
): BotService {
  const dataRoot = root ?? resolveDataRoot();
  return createBotService({
    config: createTomlConfigStore(path.join(dataRoot, 'config.toml'), dataRoot),
    profile: createFsProfilePort(dataRoot),
    journal: new BotIdentityJournal(getDuyaAgentsRoot(dataRoot)),
    logger,
    randomSuffix: cryptoRandomSuffix,
  });
}

/**
 * Construct the Host service AND roll the journal forward before the first
 * command. Construction alone cannot repair (repair is async); every caller
 * that opens a service for a command goes through here so a crash between
 * journal append and config write is completed by the next writer, not by
 * luck.
 */
export async function openHostBotService(
  root?: string,
  logger?: BotServicePorts['logger'],
): Promise<BotService> {
  const service = createHostBotService(root, logger);
  await service.repair();
  return service;
}

/**
 * The generic open for backends that assemble their own ports (the Desktop
 * config store): the same repair-before-first-command contract as
 * `openHostBotService`, without the Host file adapter. The Host's crypto
 * suffix is injected here when the caller did not bring one, so an embedder
 * keeps the S1 id-minting behavior without importing node itself.
 */
export async function openBotService(ports: BotServicePorts): Promise<BotService> {
  const service = openDomainBotService({
    ...ports,
    randomSuffix: ports.randomSuffix ?? cryptoRandomSuffix,
  });
  return service;
}
