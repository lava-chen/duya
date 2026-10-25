/**
 * bot-application.ts — the Desktop store-backed Bot service (framework plan
 * S1).
 *
 * The Desktop owns `config.toml` through its in-memory config store; the
 * standalone Host writes the file directly. Both now answer bot identity
 * commands through the SAME application service (`@duya/host/bot`), differing
 * only in this adapter: the store's `getByPath`/`set` replaces the Host's
 * read-and-rewrite-atomically. That is the S1 acceptance — Desktop and TUI
 * go through one create / update / read semantics with revision conflicts
 * and requestId dedup, instead of two writers drifting apart.
 *
 * `takenIds` is the Desktop's authoritative view (config keys + on-disk
 * trees + tombstones, `collectTakenBotIds`), so the service can never mint a
 * colliding id. The store keeps its own durability, so `snapshotForRepair`
 * is absent: the repair report records `snapshotted: false` instead of
 * pretending a backup happened.
 */

import {
  openBotService,
} from '@duya/host/bot';
import type { BotConfigStorePort, BotProfilePort } from '@duya/host/bot';
import type { BotService } from '@duya/host/bot';
import { BotIdentityJournal } from '@duya/host/bot';
import {
  getBotProfilePath,
  getDuyaAgentsRoot,
  readBotProfile,
  writeBotProfile,
} from '@duya/host/config-agents';
import type { CustomAgentConfig } from '@duya/host/config-agents';
import { collectTakenBotIds } from './agents';
import { seedBotProfileIfMissing as seedBotProfileIfMissingShared } from '@duya/host/config-agents';
import { getConfigStore } from './store-instance';
import { getLogger, LogComponent } from '../logging/logger';

function desktopConfigPort(): BotConfigStorePort {
  return {
    async readAgents() {
      return (getConfigStore().getByPath('agents') ?? {}) as Record<string, CustomAgentConfig>;
    },
    async writeAgents(next) {
      getConfigStore().set('agents', next);
    },
    async takenIds() {
      // The Desktop's authoritative id view already merges the config keys
      // with the on-disk trees and tombstones.
      return collectTakenBotIds();
    },
  };
}

function desktopProfilePort(): BotProfilePort {
  return {
    seedProfile(id, entry) {
      // The shared seed returns whether it wrote; the Desktop wrapper adds
      // the component logger and returns void, so the port calls the shared
      // one directly (same store dir, same never-throw contract).
      const written = seedBotProfileIfMissingShared(
        getConfigStore().getConfigDir(),
        id,
        entry,
        {
          onError: (error: unknown) => {
            getLogger().warn('bot profile seeding failed', {
              botId: id,
              error: error instanceof Error ? error.message : String(error),
            }, LogComponent.ConfigManager);
          },
        },
      );
      return Promise.resolve(written);
    },
    readProfile(id) {
      try {
        // The store's config dir IS the Desktop's duya root; the shared
        // path helper defaults to the resolved data root, which can differ
        // under a dev checkout — never mix the two.
        return Promise.resolve(readBotProfile(getBotProfilePath(id, getConfigStore().getConfigDir())));
      } catch {
        // An unsafe legacy id must not break the listing; the config entry
        // remains the fallback identity.
        return Promise.resolve(null);
      }
    },
    writeProfile(id, profile) {
      writeBotProfile(getBotProfilePath(id, getConfigStore().getConfigDir()), profile);
      return Promise.resolve();
    },
  };
}

let servicePromise: Promise<BotService> | null = null;

/**
 * The Desktop's Bot service, assembled once per process. The first call
 * rolls the identity journal forward, so a crash between the journal append
 * and the config-store write is completed by the next writer.
 */
export function getDesktopBotService(): Promise<BotService> {
  if (servicePromise === null) {
    const logger = getLogger();
    servicePromise = openBotService({
      config: desktopConfigPort(),
      profile: desktopProfilePort(),
      journal: new BotIdentityJournal(getDuyaAgentsRoot()),
      logger: {
        warn: (message: string, context?: Record<string, unknown>) =>
          logger.warn(message, context ?? {}, LogComponent.ConfigManager),
        info: (message: string, context?: Record<string, unknown>) =>
          logger.info(message, context ?? {}, LogComponent.ConfigManager),
      },
    });
  }
  return servicePromise;
}

