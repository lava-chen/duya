/**
 * botChannels — data prepare step for `bot/channels.hbs` (Plan 488 P2.4
 * / 474 P2.5).
 *
 * Plan 558 split: this file holds the *data* (which platforms are
 * connectable, what the inbound cue is, which channels this bot is
 * connected to). The template under `bot/channels.hbs` renders that data
 * with no logic of its own.
 *
 * Returns null when the bot has no configured channels — the section is
 * then silently omitted, matching the pre-migration `renderBotChannels`
 * guard.
 *
 * Verified against duya's actual channel implementation:
 * - `[inbound]` cue:              `CHANNEL_INBOUND_WAKE_CUE` (channels/prompts.ts)
 * - SendMessage + `channel` field: `SendMessageTool` schema (tool/SendMessageTool/schema.ts)
 * - Address format `platform:chat`: `formatChannelAddress` (channels/types.ts)
 * - CONNECTOR_MANIFESTS:          `CONNECTOR_MANIFESTS` (channels/types.ts) — Discord + Slack
 * - Connected channel snapshot:    `ChannelSnapshot[]` via `ctx.channels` (BotPromptContext)
 *
 * Not yet implemented in duya (skipped):
 * - update_state disconnect (duya's update_state targets memory tiers, not channels)
 * - Real-time pacing guidance (no streaming/delivery mechanism yet)
 * - Content degradation (duya has no widget/card rendering)
 */

import type { BotPromptContext } from './framework.js'
import {
  CONNECTOR_MANIFESTS,
  formatChannelAddress,
  type ChannelAddress,
} from '../../channels/types.js'
import { CHANNEL_INBOUND_WAKE_CUE } from '../../channels/prompts.js'

export interface BotChannelsContext extends BotPromptContext {
  /** Formatted bullet for each connected channel (or a single "none" bullet). */
  channelBullets: string[]
  /** Formatted manifest lines for currently connectable platforms. */
  availableManifests: string[]
  /** Comma-separated names of platforms that are "coming soon". */
  comingSoonManifests: string
  /** Inbound wake cue (channel/prompts.ts constant). */
  inboundCue: string
}

export function prepareChannelsContext(ctx: BotPromptContext): BotChannelsContext | null {
  const channels = ctx.channels
  if (!channels || channels.length === 0) return null

  const channelBullets: string[] = channels.map((channel) => {
    const addr: ChannelAddress = {
      platform: channel.platform,
      chat: channel.chat ?? '',
    }
    const addrStr = addr.chat ? `${addr.platform}:${addr.chat}` : addr.platform
    return `${addrStr} ("${channel.label}") [${channel.status}]`
  })

  const availableManifests: string[] = []
  for (const manifest of CONNECTOR_MANIFESTS) {
    if (manifest.availability !== 'available') continue
    const head = `${manifest.displayName}: ${manifest.blurb}\nCredential: ${manifest.credentialLabel}.`
    if (manifest.connectGuide) {
      const guide = manifest.connectGuide
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n  ')
      availableManifests.push(`${head}\n  ${guide}`)
    } else {
      availableManifests.push(head)
    }
  }

  const comingSoon = CONNECTOR_MANIFESTS.filter((m) => m.availability === 'coming-soon')
  const comingSoonManifests = comingSoon.map((m) => m.displayName).join(', ')

  return {
    ...ctx,
    channelBullets,
    availableManifests,
    comingSoonManifests,
    inboundCue: CHANNEL_INBOUND_WAKE_CUE,
  }
}