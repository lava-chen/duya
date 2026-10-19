import type { FileAttachment, Message } from '@/types/message';
import { decodeMessageAttachments } from './decode-message-attachments';

export interface ComposerEditDraft { key: string; text: string; attachments: FileAttachment[]; }

export function messageEditDraft(message: Message): ComposerEditDraft {
  const content = message.displayContent ?? message.content;
  const text = typeof content === 'string' ? content : content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text)).join('\n');
  return { key: crypto.randomUUID(), ...decodeMessageAttachments(text, message.attachments) };
}

export function mailboxAttachments(json: string | null): FileAttachment[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is FileAttachment => !!item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.name === 'string'
      && typeof item.type === 'string' && typeof item.url === 'string'
      && typeof item.size === 'number');
  } catch { return []; }
}
