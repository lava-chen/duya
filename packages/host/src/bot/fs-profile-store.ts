/**
 * fs-profile-store.ts — the Host's fs backend of the profile port (framework
 * plan S2).
 *
 * `profile.json` access for the standalone Host: seed-once on create (via the
 * shared `seedBotProfileIfMissing`), read with the legacy config fallback,
 * atomic whole-profile write. Unsafe legacy config keys never become paths —
 * the bot-id rule guards every path join.
 */

import { isSafeBotId } from '@duya/bot';
import type { BotProfilePort } from '@duya/bot';
import { readBotProfile, writeBotProfile } from '../config-agents/bot-profile.js';
import { getBotProfilePath } from '../config-agents/bot-paths.js';
import { seedBotProfileIfMissing } from '../config-agents/agent-config-core.js';

export function createFsProfilePort(dataRoot: string): BotProfilePort {
  return {
    seedProfile(id, entry) {
      return Promise.resolve(seedBotProfileIfMissing(dataRoot, id, entry));
    },
    readProfile(id) {
      // Legacy config keys that fail the bot-id rule never become paths.
      if (!isSafeBotId(id)) return Promise.resolve(null);
      return Promise.resolve(readBotProfile(getBotProfilePath(id, dataRoot)));
    },
    writeProfile(id, profile) {
      if (!isSafeBotId(id)) return Promise.resolve();
      writeBotProfile(getBotProfilePath(id, dataRoot), profile);
      return Promise.resolve();
    },
  };
}
