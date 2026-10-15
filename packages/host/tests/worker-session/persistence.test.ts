import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@duya/agent-protocol/transcript';
import type { AttachmentWithData, CoreDataHostStores } from '@duya/data/core-stores';
import { createHostLocalAttachmentApi } from '../../src/local-attachment-api.js';

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  storeParsedDocument: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/worker-db-client.js', () => ({
  messageDb: { append: mocks.append },
  attachmentDb: { storeParsedDocument: mocks.storeParsedDocument },
}));

vi.mock('../../src/worker-logger.js', () => ({
  logger: { error: mocks.error, warn: mocks.warn },
}));

import { appendMessages, storeParsedDocumentAttachment } from '../../src/worker-session/persistence.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('worker session persistence', () => {
  it('awaits message appends and preserves the successful count', async () => {
    const messages: Message[] = [
      { id: 'message-1', role: 'assistant', content: 'Saved answer' },
      { id: 'message-2', role: 'user', content: 'Follow-up' },
    ];
    const receipt = { success: true, count: 2 };
    mocks.append.mockResolvedValueOnce(receipt);

    await expect(appendMessages('session-1', messages)).resolves.toEqual(receipt);
    expect(mocks.append).toHaveBeenCalledWith('session-1', messages);
  });

  it('retains the legacy failed-append result and logs IPC errors', async () => {
    const error = new Error('IPC channel closed');
    mocks.append.mockRejectedValueOnce(error);

    await expect(appendMessages('session-1', [])).resolves.toEqual({ success: false, count: 0 });
    expect(mocks.error).toHaveBeenCalledWith('appendMessages failed (IPC)', error, { sessionId: 'session-1' });
  });

  it('preserves a failed append receipt from the Host bridge', async () => {
    const receipt = { success: false, count: 0, reason: 'transaction_failed' };
    mocks.append.mockResolvedValueOnce(receipt);

    await expect(appendMessages('session-1', [])).resolves.toEqual(receipt);
  });

  it('awaits parsed-document persistence and omits absent optional fields', async () => {
    mocks.storeParsedDocument.mockResolvedValueOnce({ success: true });

    await expect(storeParsedDocumentAttachment('message-1', 'session-1', {
      filename: 'report.txt',
      filePath: 'C:/workspace/report.txt',
      charCount: 12,
      text: 'parsed report',
    })).resolves.toEqual({ success: true });

    expect(mocks.storeParsedDocument).toHaveBeenCalledWith('message-1', 'session-1', {
      filename: 'report.txt',
      filePath: 'C:/workspace/report.txt',
      charCount: 12,
      text: 'parsed report',
    });
  });

  it('preserves document path, text, extraction mode, and image chunk bytes', async () => {
    const imageChunks = [
      { base64: 'first-image-bytes', mediaType: 'image/png' },
      { base64: 'second-image-bytes', mediaType: 'image/jpeg' },
    ];
    mocks.storeParsedDocument.mockResolvedValueOnce({ success: true });

    await expect(storeParsedDocumentAttachment('message-2', 'session-1', {
      filename: 'scan.pdf',
      filePath: 'C:/workspace/scan.pdf',
      charCount: 2400,
      text: 'extracted page text',
      extractMethod: 'hybrid',
      imageChunks,
    })).resolves.toEqual({ success: true });

    expect(mocks.storeParsedDocument).toHaveBeenCalledWith('message-2', 'session-1', {
      filename: 'scan.pdf',
      filePath: 'C:/workspace/scan.pdf',
      charCount: 2400,
      text: 'extracted page text',
      extractMethod: 'hybrid',
      imageChunks,
    });
  });

  it('propagates parsed-document IPC failures after awaiting the write', async () => {
    const error = new Error('attachment store unavailable');
    mocks.storeParsedDocument.mockRejectedValueOnce(error);

    await expect(storeParsedDocumentAttachment('message-1', 'session-1', {
      filename: 'report.txt',
      filePath: 'C:/workspace/report.txt',
      charCount: 12,
      text: 'parsed report',
    })).rejects.toBe(error);
  });

  it('skips parsed-document writes with an empty message id', async () => {
    await expect(storeParsedDocumentAttachment('', 'session-1', {
      filename: 'report.txt',
      filePath: 'C:/workspace/report.txt',
      charCount: 12,
      text: 'parsed report',
    })).resolves.toEqual({ success: false });

    expect(mocks.storeParsedDocument).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      'storeParsedDocumentAttachment: messageId is empty, skipping',
      { filename: 'report.txt' },
    );
  });

  it('round-trips parsed document fields through the Host local attachment API', async () => {
    const rows = new Map<string, AttachmentWithData>();
    const save = vi.fn((input: {
      id?: string;
      messageId?: string | null;
      sessionId: string;
      type: string;
      mimeType?: string | null;
      data: string;
      filename?: string;
      originalUrl?: string | null;
    }) => {
      const id = input.id ?? 'generated';
      const row: AttachmentWithData = {
        id,
        messageId: input.messageId ?? null,
        sessionId: input.sessionId,
        attachmentType: input.type,
        mimeType: input.mimeType ?? null,
        filePath: `attachments/${id}/${input.filename ?? 'attachment'}`,
        originalUrl: input.originalUrl ?? null,
        createdAt: 17,
        data: input.data,
      };
      rows.set(id, row);
      return row;
    });
    const api = createHostLocalAttachmentApi({
      stores: {
        attachments: {
          save,
          getForSession: (sessionId: string) => [...rows.values()].filter((row) => row.sessionId === sessionId),
          getForMessage: (messageId: string) => [...rows.values()].filter((row) => row.messageId === messageId),
        },
      } as unknown as Pick<CoreDataHostStores, 'attachments'>,
      legacyAttachments: {
        getImageAttachmentsForSession: () => [],
        getParsedDocumentsForSession: () => [],
        getParsedDocumentsForMessage: () => [],
      },
    });
    const input = {
      messageId: 'message-3',
      sessionId: 'session-1',
      filename: 'scan.pdf',
      filePath: 'C:/workspace/scan.pdf',
      charCount: 2400,
      text: 'extracted page text',
      extractMethod: 'hybrid',
      imageChunks: [{ base64: 'preserved-image-bytes', mediaType: 'image/png' }],
    };

    await expect(api.storeParsedDocument(input)).resolves.toEqual({ success: true });
    const [storedDocument] = await api.getParsedDocumentsForMessage(input.messageId);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'message-3-parsed-doc',
      messageId: 'message-3',
      sessionId: 'session-1',
      type: 'parsed_document',
      originalUrl: 'C:/workspace/scan.pdf',
    }));
    expect(storedDocument).toMatchObject({
      id: 'message-3-parsed-doc',
      message_id: 'message-3',
      session_id: 'session-1',
      filename: 'scan.pdf',
      filePath: 'C:/workspace/scan.pdf',
      charCount: 2400,
      extractMethod: 'hybrid',
      text: 'extracted page text',
      imageChunks: JSON.stringify(input.imageChunks),
    });
  });
});
