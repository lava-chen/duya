/**
 * botChannels — real section renderer (Plan 488 P2.4 / 474 P2.5).
 *
 * Renders the bot's connected external channels (Discord/Slack) from the
 * prompt context. Aligned with grok-bot `renderChannelsSystemPrompt`.
 *
 * Each piece of guidance is verified against duya's actual channel
 * implementation:
 * - `[inbound]` cue:              `CHANNEL_INBOUND_WAKE_CUE` (channels/prompts.ts)
 * - `[channel-delivery-failed]`:  `CHANNEL_DELIVERY_FAILED_WAKE_CUE` (channels/prompts.ts)
 * - `secret-request` type:        `SecretRequestContent` + `SEND_MESSAGE_TYPES` (channels/types.ts)
 * - SendMessage + `channel` field: `SendMessageTool` schema (tool/SendMessageTool/schema.ts)
 * - Address format `platform:chat`: `formatChannelAddress` (channels/types.ts)
 * - Reaction inbound:             `ChannelInboundEnvelope.reaction` (channels/types.ts)
 * - CONNECTOR_MANIFESTS:          `CONNECTOR_MANIFESTS` (channels/types.ts) — Discord + Slack
 * - Connected channel snapshot:    `ChannelSnapshot[]` via `ctx.channels` (BotPromptContext)
 *
 * Not yet implemented in duya (skipped):
 * - update_state disconnect (duya's update_state targets memory tiers, not channels)
 * - Real-time pacing guidance (no streaming/delivery mechanism yet)
 * - Content degradation (duya has no widget/card rendering)
 *
 * The channel data is injected into `ctx.channels` by `loadBotPromptContext`
 * (loader.ts) which reads from `agents/<agentId>/channels/<platform>/connection.json`.
 *
 * Pure over ctx: returns null when no channels are configured.
 */

import type { BotPromptContext } from './framework.js'
import {
  CONNECTOR_MANIFESTS,
  formatChannelAddress,
  type ChannelAddress,
} from '../../channels/types.js'
import { CHANNEL_INBOUND_WAKE_CUE } from '../../channels/prompts.js'

function describePlatform(platform: string): string {
  const manifest = CONNECTOR_MANIFESTS.find((m) => m.platform === platform)
  if (!manifest) return platform
  return `${manifest.displayName}: ${manifest.blurb} Credential: ${manifest.credentialLabel}.`
}

function formatChannelLine(addr: ChannelAddress): string {
  return `${addr.platform}:${addr.chat}`
}

export function renderBotChannels(ctx: BotPromptContext): string | null {
  const channels = ctx.channels
  if (!channels || channels.length === 0) return null

  const lines: string[] = []

  // ---------------------------------------------------------------
  // 1. Intro
  // ---------------------------------------------------------------
  lines.push('## Channels')
  lines.push(
    'You are connected to external messaging platforms beyond this in-app chat.',
  )
  lines.push('')

  // ---------------------------------------------------------------
  // 2. Address format
  // ---------------------------------------------------------------
  lines.push('**Address format**: `platform:chat` (e.g. `discord:guild=123:channel=456`, `slack:C12345`)')
  lines.push('')

  // ---------------------------------------------------------------
  // 3. Security rules
  // ---------------------------------------------------------------
  lines.push(
    '**Security**: Never ask the user to paste a token or API key into this chat, and never write credentials into files — that exposes them in the transcript. To collect a credential, call SendMessage with `type: "secret-request"` and `{ label, connector, field }`. The user types into a masked field; the value goes straight to the secret store and you never see the raw value.',
  )
  lines.push('')

  // ---------------------------------------------------------------
  // 4. INBOUND behavior
  // ---------------------------------------------------------------
  lines.push(
    `**INBOUND**: When someone messages you on a connected channel, you are woken with a hidden message starting with the cue \`${CHANNEL_INBOUND_WAKE_CUE}\` naming the source address and sender. That is a real person reaching out on that platform, not the user typing here. Reply on that same channel by calling SendMessage with \`channel\` set to the address. If you omit \`channel\`, your message goes to this in-app chat instead.`,
  )
  lines.push('')

  // ---------------------------------------------------------------
  // 5. REACTIONS behavior
  // ---------------------------------------------------------------
  lines.push(
    `**REACTIONS**: The \`${CHANNEL_INBOUND_WAKE_CUE}\` cue also fires when someone reacts to one of your messages (e.g. ❤️). A reaction is a lightweight acknowledgement — you usually do not need to reply, only act on it if it is useful.`,
  )
  lines.push('')

  // ---------------------------------------------------------------
  // 6. OUTBOUND behavior
  // ---------------------------------------------------------------
  lines.push(
    '**OUTBOUND**: SendMessage accepts an optional `channel` field. Set it to an address to deliver there; omit it to send to this in-app chat. By default, reply to an inbound message on the channel it came from.',
  )
  lines.push('')

  // ---------------------------------------------------------------
  // 7. Platform listing
  // ---------------------------------------------------------------
  lines.push('**Platforms you can connect** (use SendMessage with `type: "secret-request"` to collect credentials):')
  for (const manifest of CONNECTOR_MANIFESTS) {
    if (manifest.availability === 'available') {
      lines.push(`- ${manifest.displayName}: ${manifest.blurb}`)
      lines.push(`  Credential: ${manifest.credentialLabel}.`)
      if (manifest.connectGuide) {
        for (const guideLine of manifest.connectGuide.split('\n')) {
          lines.push(`  ${guideLine.trim()}`)
        }
      }
    }
  }
  const comingSoon = CONNECTOR_MANIFESTS.filter((m) => m.availability === 'coming-soon')
  if (comingSoon.length > 0) {
    lines.push(
      `Coming soon (not connectable yet): ${comingSoon.map((m) => m.displayName).join(', ')}.`,
    )
  }
  lines.push('')

  // ---------------------------------------------------------------
  // 8. Currently connected channels
  // ---------------------------------------------------------------
  lines.push('**Currently connected**:')
  if (channels.length === 0) {
    lines.push(
      '  No channels connected yet. Offer to connect one when it would help the user reach people where they already are.',
    )
  } else {
    for (const channel of channels) {
      // Format: "discord:guild=...:channel=... (My Discord Server) [configured]"
      const addr: ChannelAddress = {
        platform: channel.platform,
        chat: channel.chat ?? '',
      }
      const addrStr = addr.chat ? formatChannelLine(addr) : addr.platform
      lines.push(
        `  - ${addrStr} ("${channel.label}") [${channel.status}]`,
      )
    }
  }

  return lines.join('\n')
}
