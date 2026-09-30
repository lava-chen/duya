import { describe, expect, it } from 'vitest';
import { messageEditDraft, mailboxAttachments } from './chat-edit-draft';
import type { Message } from '@/types/message';

describe('composer edit restoration', () => {
  it('restores user text and every attachment without modifying the original', () => {
    const attachments = ['a', 'b'].map((id) => ({ id, name: 'image.png', type: 'image/png', url: `data:image/png;base64,${id}`, size: 1 }));
    const message: Message = { id: 'm', role: 'user', content: 'Synthetic attachment context', displayContent: 'compare images', timestamp: 1, attachments };
    expect(messageEditDraft(message)).toMatchObject({ text: 'compare images', attachments });
    expect(message.attachments).toHaveLength(2);
  });
  it('handles image-only messages and malformed stored pending attachments', () => {
    expect(messageEditDraft({ id: 'm', role: 'user', content: [{ type: 'image' }], timestamp: 1 }).text).toBe('');
    expect(mailboxAttachments('[null,{},3]')).toEqual([]);
    expect(mailboxAttachments('{')).toEqual([]);
  });
});
