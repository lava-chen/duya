/**
 * toml-config-store.ts — the Host's TOML file backend of the identity store
 * port (framework plan S2).
 *
 * The Host has no in-memory config store, so it reads `config.toml` fresh and
 * rewrites the `[agents]` table atomically (the discipline
 * `config-agents/config-file.ts` owns). The port shape and its contract are
 * `@duya/bot`'s `BotIdentityStorePort`; this adapter is the Host half of the
 * S1 seam, extracted so the domain package stays IO-free.
 */

import * as fs from 'node:fs';
import type { BotIdentityStorePort } from '@duya/bot';
import {
  readAgentsTable,
  readConfigTomlDocument,
  writeConfigAgentsTable,
} from '../config-agents/config-file.js';
import { mergeTakenBotIds } from '../config-agents/agent-config-core.js';

export function createTomlConfigStore(configPath: string, dataRoot: string): BotIdentityStorePort {
  return {
    async readAgents() {
      return readAgentsTable(await readConfigTomlDocument(configPath));
    },
    async writeAgents(next) {
      await writeConfigAgentsTable(configPath, next);
    },
    async takenIds(configKeys) {
      return mergeTakenBotIds(configKeys, dataRoot);
    },
    async snapshotForRepair() {
      if (!fs.existsSync(configPath)) return false;
      fs.copyFileSync(configPath, `${configPath}.pre-repair-${Date.now()}.bak`);
      return true;
    },
  };
}
