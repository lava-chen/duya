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

/**
 * Reply guidance appended right after the cue. Without it, bots treat an
 * inbound channel message like an in-app one and answer with plain turn
 * text — which only lands in the desktop chat, leaving the external sender
 * in silence. The hint makes the routing contract explicit: replies must
 * go through SendMessage with the channel address from each line.
 */
export const CHANNEL_INBOUND_REPLY_HINT =
  'The messages below arrived from an external messaging channel. The sender cannot see this chat, and your final written reply does not reach them either — to answer, call SendMessage with channel set to the address shown in each line (e.g. channel="telegram:12345"); without channel your reply only lands in the in-app chat.';

/** Cue prepended to delivery-failure wake prompts. */
export const CHANNEL_DELIVERY_FAILED_WAKE_CUE = '[channel-delivery-failed]';

/**
 * Cue prepended to ack-redrive wake prompts (grok ack-obligation parity):
 * fired when an inbound wake run finished without a single SendMessage, so
 * the external sender is left waiting with no visible reply.
 */
export const CHANNEL_ACK_REDRIVE_WAKE_CUE = '[channel-ack-redrive]';

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
 * Emits the cue, a reply-routing hint, then groups envelopes by address,
 * formats each as a block, and joins them. If the total exceeds
 * MAX_INBOUND_TEXT_CHARS, later envelopes are truncated with a
 * `<truncated>` marker.
 *
 * @param envelopes - Inbound envelopes, newest first recommended.
 * @param cue - Override the default cue (mostly for testing).
 */
export function buildChannelInboundWakePrompt(
  envelopes: ChannelInboundEnvelope[],
  cue = CHANNEL_INBOUND_WAKE_CUE,
): string {
  if (!envelopes.length) return '';

  const blocks: string[] = [cue, CHANNEL_INBOUND_REPLY_HINT];

  // Group by address
  const byAddress = new Map<string, ChannelInboundEnvelope[]>();
  for (const env of envelopes) {
    const key = formatAddress(env.address);
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key)!.push(env);
  }

  let totalChars = cue.length + CHANNEL_INBOUND_REPLY_HINT.length + 2;
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
 * Format a single inbound envelope into its prompt block: the header line
 * (text or reaction) plus one indented line per persisted attachment
 * (plan 507 P2.1). Attachment lines count toward the caller's
 * MAX_INBOUND_TEXT_CHARS budget as part of the combined block.
 *
 * Format variants:
 * - Text message:  `"On <platform>, from <addr>: <sender>: <text>"`
 * - Media-only:    header line with empty text, then attachment lines
 * - Reaction only: `"On <platform>, from <addr>: <sender> reacted <emoji> to your message: '<quote>'"`
 * - Reaction no quote: `"On <platform>, from <addr>: <sender> reacted <emoji>"`
 */
function formatInboundEnvelope(env: ChannelInboundEnvelope, addrKey: string): string {
  const platform = env.address.platform;
  const sender = env.sender;
  const text = env.text;

  // Reaction case — reactions carry no attachments (plan 507)
  if (env.reaction) {
    const emoji = env.reaction.emoji;
    const quote =
      env.reaction.messageQuote !== null
        ? ` to your message: '${truncate(env.reaction.messageQuote, 200)}'`
        : '';
    return `On ${platform}, from ${addrKey}: ${sender} reacted ${emoji}${quote}`;
  }

  // Text case (+ attachment lines, plan 507 P2.1)
  const content = truncate(text, 2000);
  const lines = [`On ${platform}, from ${addrKey}: ${sender}: ${content}`];
  for (const attachment of env.attachments ?? []) {
    lines.push(
      `  [attachment saved to: ${attachment.path} ` +
        `(${attachment.name}, ${attachment.mimeType}, ${formatAttachmentSize(attachment.size)})]`,
    );
  }
  return lines.join('\n');
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

/**
 * Build the hidden ack-redrive wake prompt: the inbound run finished without
 * any SendMessage, so the external sender never saw a reply. The bot is
 * re-prompted to acknowledge or answer via SendMessage (grok
 * buildAckRedrivePrompt parity — a short hidden instruction, not a full
 * replay of the original message).
 */
export function buildChannelAckRedrivePrompt(
  envelopes: ChannelInboundEnvelope[],
  cue = CHANNEL_ACK_REDRIVE_WAKE_CUE,
): string {
  if (!envelopes.length) return '';

  const blocks: string[] = [
    cue,
    'Your previous run on the inbound message(s) below finished WITHOUT calling SendMessage, so the sender on the external channel is still waiting. Invoke SendMessage now with the channel address shown to acknowledge or answer — even a one-line ack counts. Do not repeat work you already completed; if a reply already went out, simply confirm the sender was answered.',
  ];
  for (const env of envelopes) {
    const addr = formatAddress(env.address);
    const text = env.text ? truncate(env.text, 200) : '(media only)';
    blocks.push(`- from ${env.sender} on ${addr}: ${text}`);
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

/**
 * Human-readable byte size for attachment lines: plain bytes under 1 KB,
 * one decimal for KB/MB/GB (e.g. "800 B", "12.3 KB", "2.1 MB").
 */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}
