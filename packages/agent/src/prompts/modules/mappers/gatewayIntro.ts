/**
 * Mapper for the intro module — Plan 551.
 *
 * Renders the channel display name the gateway intro paragraph opens
 * with. An absent communicationPlatform falls back to the legacy
 * 'a messaging' placeholder; unknown platforms pass through raw.
 */

import type { PromptContext } from '../../types.js'

const PLATFORM_NAMES: Record<string, string> = {
  weixin: 'WeChat',
  feishu: 'Feishu',
  telegram: 'Telegram',
  qq: 'QQ',
}

export function mapGatewayIntroSlots(ctx: PromptContext): Record<string, unknown> {
  const platform = ctx.communicationPlatform ?? 'a messaging'
  return {
    intro_platform_name: PLATFORM_NAMES[platform] ?? platform,
  }
}
