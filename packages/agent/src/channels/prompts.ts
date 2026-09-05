/**
 * Channel wake prompt builders (plan 488 §3.6).
 *
 * These functions build the prompt strings that are prepended to the agent's
 * context when a channel event (inbound message or delivery failure) wakes a bot.
 *
 * All functions are pure — no Electron imports, no I/O.
 *
 * Prompt conventions (mirroring grok-bot `channel-messaging.ts`):
 * - Start with `[inbound]` cue to signal hidden wake
 * - One block per channel address
 * - Reactions get their own formatted line
 * - Max total prompt ~8000 chars (platform-enforced)
 */

import type {
  ChannelAddress,
  ChannelInboundEnvelope,
  ChannelOutboundMessage,
  DeliveryFailure,
} from './types.js';

// =============================================================================
// Wake cues
// =============================================================================

/** Cue prepended to inbound wake prompts. */
export const CHANNEL_INBOUND_WAKE_CUE = '[inbound]';

/** Cue prepended to delivery-failure wake prompts. */
export const CHANNEL_DELIVERY_FAILED_WAKE_CUE = '[channel-delivery-failed]';

// =============================================================================
// Limits
// =============================================================================

/**
 * Maximum combined length of all inbound envelope text (chars).
 * Platforms may impose stricter limits; this is a safe default.
 */
export const MAX_INBOUND_TEXT_CHARS = 8000;

// =============================================================================
// Inbound prompt
// =============================================================================

/**
 * Build the hidden wake prompt for one or more inbound channel envelopes.
 *
 * Groups envelopes by address, formats each as a block, and joins them.
 * If the total exceeds MAX_INBOUND_TEXT_CHARS, later envelopes are truncated
 * with a `<truncated>` marker.
 *
 * @param envelopes - Inbound envelopes, newest first recommended.
 * @param cue - Override the default cue (mostly for testing).
 */
export function buildChannelInboundWakePrompt(
  envelopes: ChannelInboundEnvelope[],
  cue = CHANNEL_INBOUND_WAKE_CUE,
): string {
  if (!envelopes.length) return '';

  const blocks: string[] = [cue];

  // Group by address
  const byAddress = new Map<string, ChannelInboundEnvelope[]>();
  for (const env of envelopes) {
    const key = formatAddress(env.address);
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key)!.push(env);
  }

  let totalChars = cue.length + 1;
  let truncated = false;

  for (const [addrKey, envs] of byAddress) {
    for (const env of envs) {
      const line = formatInboundEnvelope(env, addrKey);
      if (totalChars + line.length + 1 > MAX_INBOUND_TEXT_CHARS) {
        truncated = true;
        break;
      }
      blocks.push(line);
      totalChars += line.length + 1;
    }
    if (truncated) break;
  }

  if (truncated) {
    blocks.push(`<${MAX_INBOUND_TEXT_CHARS} character limit reached — earlier messages truncated>`);
  }

  return blocks.join('\n');
}

/**
 * Format a single inbound envelope into one line of prompt text.
 *
 * Format variants:
 * - Text message:  `"On <platform>, from <addr>: <sender>: <text>"`
 * - Reaction only: `"On <platform>, from <addr>: <sender> reacted <emoji> to your message: '<quote>'"`
 * - Reaction no quote: `"On <platform>, from <addr>: <sender> reacted <emoji>"`
 */
function formatInboundEnvelope(env: ChannelInboundEnvelope, addrKey: string): string {
  const platform = env.address.platform;
  const sender = env.sender;
  const text = env.text;

  // Reaction case
  if (env.reaction) {
    const emoji = env.reaction.emoji;
    const quote =
      env.reaction.messageQuote !== null
        ? ` to your message: '${truncate(env.reaction.messageQuote, 200)}'`
        : '';
    return `On ${platform}, from ${addrKey}: ${sender} reacted ${emoji}${quote}`;
  }

  // Text case
  const content = truncate(text, 2000);
  return `On ${platform}, from ${addrKey}: ${sender}: ${content}`;
}

// =============================================================================
// Delivery-failure prompt
// =============================================================================

/**
 * Build the hidden wake prompt for channel delivery failures.
 *
 * Bot is woken with this prompt so it can decide to retry, alert, or give up.
 */
export function buildChannelDeliveryFailureWakePrompt(
  failures: DeliveryFailure[],
  cue = CHANNEL_DELIVERY_FAILED_WAKE_CUE,
): string {
  if (!failures.length) return '';

  const blocks: string[] = [cue];

  for (const f of failures) {
    const addr = formatAddress(f.address);
    const reason = f.reason;
    const time = new Date(f.failedAt).toISOString();

    let content = `Failed to deliver message to ${f.address.platform} channel ${addr} at ${time}. Reason: ${reason}.`;

    // Include outbound content if it's a text message
    if (f.outbound.kind === 'text' && f.outbound.content) {
      content += ` Original message: '${truncate(f.outbound.content, 300)}'`;
    }

    blocks.push(content);
  }

  return blocks.join('\n');
}

// =============================================================================
// Outbound prompt (for debugging / logging — not used for agent wake)
// =============================================================================

/**
 * Build a human-readable summary of an outbound channel message.
 * Used by channelDelivery for logging, not for agent prompts.
 */
export function buildChannelOutboundMessage(outbound: ChannelOutboundMessage): string {
  if (outbound.kind === 'text') {
    return truncate(outbound.content ?? '', 2000);
  }
  if (outbound.kind === 'attachment') {
    const caption = outbound.caption ? ` (caption: "${truncate(outbound.caption, 200)}")` : '';
    return `[attachment] ${outbound.url}${caption}`;
  }
  return '[unknown outbound message kind]';
}

// =============================================================================
// Utilities
// =============================================================================

function formatAddress(addr: ChannelAddress): string {
  return `${addr.platform}:${addr.chat}`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
