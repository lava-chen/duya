/**
 * Platform Hints - Communication platform-specific guidance
 * 
 * These hints are injected into the system prompt to inform the agent
 * about the communication platform's capabilities and limitations.
 * Inspired by hermes-agent's PLATFORM_HINTS system.
 */

import type { CommunicationPlatform } from './types.js'

/**
 * Platform-specific hints that inform the agent about rendering capabilities,
 * message format limitations, and platform-specific features.
 */
export const PLATFORM_HINTS: Partial<Record<CommunicationPlatform, string>> = {
  cli: (
    'You are running in a CLI (Command Line Interface) environment. ' +
    'Try not to use markdown - prefer simple text renderable inside a terminal. ' +
    'Keep responses concise and terminal-friendly. ' +
    'Do NOT use MEDIA: tags — those are only intercepted on messaging platforms; ' +
    'on the CLI they render as literal text. When referring to a file you ' +
    'created or changed, just state its absolute path in plain text.'
  ),

  'duya-app': (
    'You are running in the Duya desktop application. ' +
    'Markdown formatting is fully supported and will be rendered beautifully. ' +
    'You can use all GitHub-flavored markdown features including code blocks with syntax highlighting, ' +
    'tables, task lists, and inline formatting. ' +
    'The application supports rich media display and interactive elements.'
  ),

  weixin: (
    'You are on Weixin/WeChat platform. ' +
    'Markdown formatting is supported, so you may use it when it improves readability, ' +
    'but keep the message compact and chat-friendly. ' +
    'Messages should be concise as they appear in a chat interface. ' +
    'Avoid overly long responses - break them into multiple messages if needed. ' +
    'Use simple formatting that works well on mobile devices. ' +
    'You can send media files natively: include MEDIA:/absolute/path/to/file ' +
    'in your response. Images are sent as native photos, videos play inline, ' +
    'and other files arrive as downloadable documents.'
  ),

  feishu: (
    'You are on Feishu/Lark platform. ' +
    'Markdown formatting is supported with some limitations. ' +
    'Keep responses well-structured and suitable for a collaboration workspace. ' +
    'You can use code blocks, lists, and basic formatting. ' +
    'Consider that users may be viewing this in a work context. ' +
    'You can send media files natively: include MEDIA:/absolute/path/to/file ' +
    'in your response. Images (.jpg, .png, .webp) are uploaded and displayed inline, ' +
    'and other files arrive as attachments.'
  ),

  telegram: (
    'You are on Telegram platform. ' +
    'Standard markdown is automatically converted to Telegram format. ' +
    'Supported: **bold**, *italic*, ~~strikethrough~~, ||spoiler||, ' +
    '`inline code`, ```code blocks```, [links](url), and ## headers. ' +
    'Keep responses concise and chat-friendly. ' +
    'You can send media files natively: include MEDIA:/absolute/path/to/file ' +
    'in your response. Images (.png, .jpg, .webp) appear as photos, ' +
    'audio (.ogg) sends as voice bubbles, and videos (.mp4) play inline.'
  ),

  qq: (
    'You are on QQ platform (Official QQ Bot API v2). ' +
    'Markdown formatting is supported when markdown_support is enabled (default). ' +
    'Keep messages concise and chat-friendly as they appear in QQ chat interface. ' +
    'Messages have a 4000 character limit; long responses will be split automatically. ' +
    'Use simple formatting that works well on mobile devices. ' +
    'Support C2C private chat, group @messages, and guild channel messages. ' +
    'You can send media files natively: include MEDIA:/absolute/path/to/file ' +
    'in your response. Images are sent as native photos, and other files ' +
    'arrive as downloadable documents.'
  ),

}

/**
 * Get the platform hint for a given communication platform.
 * Returns undefined if the platform is not recognized or not provided.
 */
export function getPlatformHint(platform?: CommunicationPlatform): string | undefined {
  if (!platform) {
    return undefined
  }
  return PLATFORM_HINTS[platform]
}

/**
 * Check if a platform has a specific capability.
 * This can be extended to support more granular capability checks.
 */
export function hasPlatformCapability(
  platform: CommunicationPlatform,
  capability: 'markdown' | 'media' | 'interactive' | 'long_messages'
): boolean {
  const capabilities: Partial<Record<CommunicationPlatform, Set<string>>> = {
    'cli': new Set(['long_messages']),
    'duya-app': new Set(['markdown', 'media', 'interactive', 'long_messages']),
    'weixin': new Set(['markdown', 'media']),
    'feishu': new Set(['markdown', 'media', 'interactive']),
    'telegram': new Set(['markdown', 'media', 'long_messages']),
    'qq': new Set(['markdown', 'media', 'long_messages']),
  }

  return capabilities[platform]?.has(capability) ?? false
}
