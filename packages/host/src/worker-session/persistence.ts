import type { Message } from '@duya/agent-protocol/transcript';
import type { HostLocalParsedDocumentInput } from '@duya/agent-protocol/session-api';
import { attachmentDb, messageDb } from '../worker-db-client.js';
import { logger } from '../worker-logger.js';

export interface WorkerMessageAppendResult {
  readonly success: boolean;
  readonly count: number;
  readonly reason?: string;
}

export type ParsedDocumentAttachmentData = Omit<
  HostLocalParsedDocumentInput,
  'messageId' | 'sessionId'
>;

/** Append worker messages through the owning Host database bridge. */
export async function appendMessages(
  sessionId: string,
  messages: readonly Message[],
): Promise<WorkerMessageAppendResult> {
  try {
    return await messageDb.append(sessionId, [...messages]) as WorkerMessageAppendResult;
  } catch (error) {
    logger.error(
      'appendMessages failed (IPC)',
      error instanceof Error ? error : new Error(String(error)),
      { sessionId },
    );
    return { success: false, count: 0 };
  }
}

/** Persist parsed document context and image chunks through the Host bridge. */
export async function storeParsedDocumentAttachment(
  messageId: string,
  sessionId: string,
  data: ParsedDocumentAttachmentData,
): Promise<{ readonly success: boolean }> {
  if (!messageId) {
    logger.warn('storeParsedDocumentAttachment: messageId is empty, skipping', {
      filename: data.filename,
    });
    return { success: false };
  }

  const input: HostLocalParsedDocumentInput = {
    messageId,
    sessionId,
    filename: data.filename,
    filePath: data.filePath,
    charCount: data.charCount,
    text: data.text,
    ...(data.extractMethod === undefined ? {} : { extractMethod: data.extractMethod }),
    ...(data.imageChunks === undefined
      ? {}
      : { imageChunks: data.imageChunks.map((chunk) => ({ ...chunk })) }),
  };

  return await attachmentDb.storeParsedDocument(input.messageId, input.sessionId, {
    filename: input.filename,
    filePath: input.filePath,
    charCount: input.charCount,
    text: input.text,
    ...(input.extractMethod === undefined ? {} : { extractMethod: input.extractMethod }),
    ...(input.imageChunks === undefined
      ? {}
      : { imageChunks: input.imageChunks.map((chunk) => ({ ...chunk })) }),
  }) as { readonly success: boolean };
}
