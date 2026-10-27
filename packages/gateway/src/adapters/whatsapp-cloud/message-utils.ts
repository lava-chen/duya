/**
 * WhatsApp Cloud API message shaping.
 *
 * WhatsApp's own markup is a strict subset: `*bold*`, `_italic_`, `~strike~`,
 * ```mono```. Markdown sent as-is renders as literal asterisks, so every
 * outbound text goes through `formatForWhatsApp` first.
 *
 * Pure functions only — this module is unit-tested without a network.
 */

import { splitMessage } from '../../utils/index.js';
import type { WAMediaRef, WAMessage } from './types.js';

/** Meta's hard limit for one text message. */
export const MAX_TEXT_LENGTH = 4096;
/** Interactive body limit. */
export const MAX_INTERACTIVE_BODY = 1024;
/** Quick-reply button title limit. */
export const MAX_BUTTON_TITLE = 20;
/** Maximum quick-reply buttons per message. */
export const MAX_BUTTONS = 3;
/** List row title / description limits. */
export const MAX_ROW_TITLE = 24;
export const MAX_ROW_DESCRIPTION = 72;

/** Markdown → WhatsApp markup. Fenced code blocks are downgraded, not dropped. */
export function formatForWhatsApp(input: string): string {
  let out = input ?? '';
  // Protect inline/fenced code before touching emphasis markers.
  const codeBlocks: string[] = [];
  out = out.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    codeBlocks.push(`\`\`\`${code.trim()}\`\`\``);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  const inlineCode: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCode.push(`\`${code}\``);
    return `\u0000ICODE${inlineCode.length - 1}\u0000`;
  });

  // [text](url) → text (url): WhatsApp has no link syntax.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  // **bold** / __bold__ → *bold*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+)__/g, '*$1*');
  // ~~strike~~ → ~strike~
  out = out.replace(/~~([^~\n]+)~~/g, '~$1~');
  // ATX headings → bold line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Unordered bullets → •
  out = out.replace(/^\s*[-*+]\s+/gm, '• ');

  out = out.replace(/\u0000ICODE(\d+)\u0000/g, (_m, idx: string) => inlineCode[Number(idx)] ?? '');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeBlocks[Number(idx)] ?? '');
  return out;
}

/** Split for WhatsApp's 4096-unit limit without breaking on the escape hatch. */
export function splitForWhatsApp(text: string, maxLength = MAX_TEXT_LENGTH): string[] {
  return splitMessage(text, maxLength);
}

export function truncateTitle(title: string, max = MAX_BUTTON_TITLE): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export interface InteractiveButton {
  id: string;
  title: string;
}

/**
 * Quick-reply buttons (max 3) or a single-section list when the caller offers
 * more choices than WhatsApp allows on buttons.
 */
export function buildInteractivePayload(
  body: string,
  buttons: InteractiveButton[],
  options: { listButtonLabel?: string; sectionTitle?: string } = {},
): Record<string, unknown> {
  const text = (body ?? '').slice(0, MAX_INTERACTIVE_BODY);

  if (buttons.length > 0 && buttons.length <= MAX_BUTTONS) {
    return {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id.slice(0, 256), title: truncateTitle(b.title) },
        })),
      },
    };
  }

  return {
    type: 'list',
    body: { text },
    action: {
      button: truncateTitle(options.listButtonLabel ?? 'Options', MAX_BUTTON_TITLE),
      sections: [
        {
          title: (options.sectionTitle ?? 'Options').slice(0, MAX_ROW_TITLE),
          rows: buttons.slice(0, 10).map((b) => ({
            id: b.id.slice(0, 200),
            title: truncateTitle(b.title, MAX_ROW_TITLE),
            ...(b.title.length > MAX_ROW_TITLE
              ? { description: b.title.slice(0, MAX_ROW_DESCRIPTION) }
              : {}),
          })),
        },
      ],
    },
  };
}

/** Pick the media reference out of a message regardless of its type. */
export function mediaRefOf(message: WAMessage): WAMediaRef | null {
  return (
    message.image ??
    message.video ??
    message.audio ??
    message.document ??
    message.sticker ??
    null
  );
}

/**
 * Flatten an inbound message to text. Interactive replies become `/`-free
 * callback text so the gateway can route them like button presses.
 */
export function inboundTextOf(message: WAMessage): string | undefined {
  switch (message.type) {
    case 'text':
      return message.text?.body;
    case 'button':
      return message.button?.payload ?? message.button?.text;
    case 'interactive':
      return message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
    case 'location': {
      const loc = message.location;
      if (!loc) return undefined;
      const label = [loc.name, loc.address].filter(Boolean).join(', ');
      return `[location] ${loc.latitude},${loc.longitude}${label ? ` (${label})` : ''}`;
    }
    default:
      return undefined;
  }
}

/** `callbackData` for interactive replies (permission buttons arrive here). */
export function callbackDataOf(message: WAMessage): string | undefined {
  if (message.type === 'button') return message.button?.payload;
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
  }
  return undefined;
}

/** Best-effort display name for the sender. */
export function senderNameOf(contacts: Array<{ profile?: { name?: string }; wa_id?: string }> | undefined, from: string): string | undefined {
  const match = contacts?.find((c) => c.wa_id === from);
  return match?.profile?.name;
}
