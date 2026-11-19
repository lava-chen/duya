/**
 * types.ts — the platform shapes this transport reads.
 *
 * The Discord wire types live next to the legacy adapter; this module is the
 * single place the project-channel transport imports them from, so the two
 * consumers cannot drift into private copies of the same payload.
 */

import type { DiscordWebSocketPayload } from '../adapters/discord/types.js';

export type {
  DiscordChannel,
  DiscordMessage,
} from '../adapters/discord/types.js';

export type DiscordPayload = DiscordWebSocketPayload;
