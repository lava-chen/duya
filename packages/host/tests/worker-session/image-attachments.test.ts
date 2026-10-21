import { describe, expect, it, vi } from 'vitest';
import type { CoreDataHostStores, AttachmentWithData } from '@duya/data/core-stores';
import type { HostLocalImageAttachment } from '@duya/agent-protocol/session-api';
import type { MessageContent } from '@duya/agent-core/message';
import { createHostLocalAttachmentApi } from '../../src/local-attachment-api.js';
import { rehydrateContentWithAttachments } from '../../src/worker-session/image-attachments.js';

function imageAttachment(input: Partial<AttachmentWithData> & Pick<AttachmentWithData, 'id' | 'sessionId'>): AttachmentWithData {
  return {
    id: input.id,
    messageId: input.messageId ?? null,
    sessionId: input.sessionId,
    attachmentType: input.attachmentType ?? 'image',
    mimeType: input.mimeType ?? 'image/png',
    filePath: input.filePath ?? 'attachment.bin',
    originalUrl: input.originalUrl ?? null,
    createdAt: input.createdAt ?? 1,
    data: input.data ?? 'core-bytes',
  };
}

function legacyImage(id: string, created_at: number, data: string): HostLocalImageAttachment {
  return {
    id,
    message_id: 'message-1',
    session_id: 'session-1',
    attachment_type: 'image',
    mime_type: 'image/jpeg',
    data,
    original_url: `https://legacy.minimax.io/${id}.jpg`,
    created_at,
  };
}

describe('worker image attachment history', () => {
  it('merges legacy and Core image rows, preferring Core duplicates and preserving payloads', async () => {
    const coreRows = [
      imageAttachment({
        id: 'shared',
        sessionId: 'session-1',
        messageId: 'message-1',
        createdAt: 10,
        originalUrl: 'https://core.minimax.io/shared.jpg',
        data: 'core-shared-bytes',
      }),
      imageAttachment({
        id: 'ignored-document',
        sessionId: 'session-1',
        messageId: 'message-1',
        attachmentType: 'parsed_document',
        createdAt: 15,
      }),
      imageAttachment({ id: 'ignored-no-message', sessionId: 'session-1', messageId: null }),
      imageAttachment({
        id: 'core-only',
        sessionId: 'session-1',
        messageId: 'message-2',
        createdAt: 20,
        data: 'core-only-bytes',
      }),
    ];
    const api = createHostLocalAttachmentApi({
      stores: {
        attachments: {
          getForSession: () => coreRows,
        },
      } as unknown as Pick<CoreDataHostStores, 'attachments'>,
      legacyAttachments: {
        getImageAttachmentsForSession: () => [
          legacyImage('shared', 2, 'legacy-stale-bytes'),
          legacyImage('legacy-only', 5, 'legacy-only-bytes'),
        ],
        getParsedDocumentsForSession: () => [],
        getParsedDocumentsForMessage: () => [],
      },
    });

    await expect(api.getImageAttachmentsForSession('session-1')).resolves.toEqual([
      legacyImage('legacy-only', 5, 'legacy-only-bytes'),
      {
        ...legacyImage('shared', 2, 'legacy-stale-bytes'),
        created_at: 10,
        mime_type: 'image/png',
        original_url: 'https://core.minimax.io/shared.jpg',
        data: 'core-shared-bytes',
      },
      {
        id: 'core-only',
        message_id: 'message-2',
        session_id: 'session-1',
        attachment_type: 'image',
        mime_type: 'image/png',
        data: 'core-only-bytes',
        original_url: null,
        created_at: 20,
      },
    ]);
  });

  it('restores matching CDN bytes and drops unmatched CDN blocks while leaving other content alone', () => {
    const warn = vi.fn();
    const content = [
      { type: 'text', text: 'question' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://cdn.minimax.io/matched.jpg', media_type: 'image/jpeg', data: '' },
      },
      {
        type: 'image',
        source: { type: 'url', url: 'https://cdn.minimax.io/missing.jpg', media_type: 'image/jpeg', data: '' },
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'inline-bytes' } },
    ] as unknown as MessageContent[];
    const attachments = new Map([
      ['message-1', [{ mime_type: 'image/jpeg', data: 'restored-bytes', original_url: 'https://cdn.minimax.io/matched.jpg' }]],
    ]);

    expect(rehydrateContentWithAttachments(content, attachments, { warn })).toEqual([
      { type: 'text', text: 'question' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'restored-bytes' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'inline-bytes' } },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'No attachment found for CDN URL; skipping image block',
      { url: 'https://cdn.minimax.io/missing.jpg' },
      'DB',
    );
  });
});
