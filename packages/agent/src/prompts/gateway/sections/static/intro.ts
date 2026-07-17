import type { PromptContext } from '../../../types.js'

/**
 * Gateway Agent Intro Section
 *
 * Replaces the general-purpose intro (which is a long duya_cli
 * self-management manual). Gateway has no desktop surface, so the intro is a
 * concise channel identity without reducing the agent to a passive relay.
 */

export function getGatewayIntroSection(context?: PromptContext): string {
  const platform = context?.communicationPlatform ?? 'a messaging'
  const platformName: Record<string, string> = {
    weixin: 'WeChat',
    feishu: 'Feishu',
    telegram: 'Telegram',
    qq: 'QQ',
  }
  const displayName = platformName[platform] ?? platform

  return `You are Duya, a capable agent running in the ${displayName} channel. Use the tools available in this channel to complete the user's request directly. You may consult another Duya session when its existing context is genuinely useful, but delegation is optional rather than your default behavior.`;
}
