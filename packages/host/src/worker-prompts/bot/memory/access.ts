/**
 * Peer user-shard grants (framework plan S5).
 *
 * A bot may recall the legacy shared user roots (`memory/items|entities|
 * global`) and its own `agents/<id>/user` shard by default. Recalling
 * *another* bot's user shard is a data-sharing grant, so it requires an
 * explicit entry in:
 *
 *   <duyaRoot>/agents/<botId>/state/memory-access.json
 *   { "userShards": ["researcher", "scheduler"] }
 *
 * The `state/` directory is the bot-state reservation from Plan 485, and the
 * file is owned by the user (Desktop / CLI), not by the bot itself.
 *
 * Fail closed: an unsafe bot id, a missing file, unparseable JSON, or a
 * wrong-shaped payload all read as "no peer grants". A corrupt grant file
 * must never widen recall.
 */

import { readFile } from 'fs/promises'
import * as path from 'path'
import {
  parseMemoryAccessGrant,
  type BotMemoryAccessGrant,
} from '@duya/bot'
import { isSafeBotId } from '../bot-profile-reader.js'

/** Empty grant — the fail-closed default. */
export const EMPTY_MEMORY_ACCESS_GRANT: BotMemoryAccessGrant = { userShards: [] }

/**
 * `<duyaRoot>/agents/<botId>/state/memory-access.json`, or null when the bot
 * id cannot be used as a path segment.
 */
export function memoryAccessPath(duyaRoot: string, botId: string): string | null {
  if (!isSafeBotId(botId)) return null
  return path.join(duyaRoot, 'agents', botId, 'state', 'memory-access.json')
}

/** Read the peer-shard grant for one bot; never throws. */
export async function readMemoryAccessGrant(
  duyaRoot: string,
  botId: string,
): Promise<BotMemoryAccessGrant> {
  const file = memoryAccessPath(duyaRoot, botId)
  if (!file) return EMPTY_MEMORY_ACCESS_GRANT
  try {
    const raw = await readFile(file, 'utf8')
    return parseMemoryAccessGrant(JSON.parse(raw))
  } catch {
    return EMPTY_MEMORY_ACCESS_GRANT
  }
}
