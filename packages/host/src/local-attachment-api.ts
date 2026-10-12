import type {
  HostLocalAttachmentApiV1,
  HostLocalParsedDocument,
  HostLocalParsedDocumentInput,
} from '@duya/agent-protocol/session-api';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import type { AttachmentWithData } from '@duya/data/core-stores';
import type { MainAttachmentStore } from '@duya/data/main-attachment-store';

function parsePayload(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function fromCoreAttachment(attachment: AttachmentWithData): HostLocalParsedDocument {
  const payload = parsePayload(attachment.data);
  const imageChunks = payload.imageChunks;
  return {
    id: attachment.id,
    message_id: attachment.messageId ?? '',
    session_id: attachment.sessionId,
    filename: typeof payload.filename === 'string' ? payload.filename : '',
    filePath: typeof payload.filePath === 'string' ? payload.filePath : attachment.originalUrl ?? '',
    charCount: typeof payload.charCount === 'number' && Number.isFinite(payload.charCount)
      ? payload.charCount
      : 0,
    extractMethod: typeof payload.extractMethod === 'string' ? payload.extractMethod : null,
    text: typeof payload.text === 'string' ? payload.text : '',
    imageChunks: imageChunks ? JSON.stringify(imageChunks) : null,
    created_at: attachment.createdAt,
  };
}

function mergeById(
  legacy: readonly HostLocalParsedDocument[],
  current: readonly HostLocalParsedDocument[],
): HostLocalParsedDocument[] {
  const byId = new Map(legacy.map((document) => [document.id, document]));
  for (const document of current) byId.set(document.id, document);
  return [...byId.values()].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
}

/** Keep legacy paths and attachment payload details on the local-only API surface. */
export function createHostLocalAttachmentApi(options: {
  readonly stores: Pick<CoreDataHostStores, 'attachments'>;
  readonly legacyAttachments: Pick<MainAttachmentStore, 'getParsedDocumentsForSession' | 'getParsedDocumentsForMessage'>;
}): HostLocalAttachmentApiV1 {
  return {
    async storeParsedDocument(input: HostLocalParsedDocumentInput) {
      if (!input.messageId) return { success: false };
      const id = `${input.messageId}-parsed-doc`;
      options.stores.attachments.save({
        id,
        messageId: input.messageId,
        sessionId: input.sessionId,
        type: 'parsed_document',
        mimeType: 'application/pdf',
        filename: input.filename,
        originalUrl: input.filePath,
        data: JSON.stringify({
          filename: input.filename,
          filePath: input.filePath,
          charCount: input.charCount,
          text: input.text,
          extractMethod: input.extractMethod ?? null,
          imageChunks: input.imageChunks ?? [],
        }),
      });
      return { success: true };
    },
    async getParsedDocumentsForSession(sessionId) {
      const legacy = options.legacyAttachments.getParsedDocumentsForSession(sessionId);
      const current = options.stores.attachments.getForSession(sessionId)
        .filter((attachment) => attachment.attachmentType === 'parsed_document')
        .map(fromCoreAttachment);
      return mergeById(legacy, current);
    },
    async getParsedDocumentsForMessage(messageId) {
      const legacy = options.legacyAttachments.getParsedDocumentsForMessage(messageId);
      const current = options.stores.attachments.getForMessage(messageId)
        .filter((attachment) => attachment.attachmentType === 'parsed_document')
        .map(fromCoreAttachment);
      return mergeById(legacy, current);
    },
  };
}
