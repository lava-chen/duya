import { afterEach, describe, expect, it } from 'vitest';

type DbRequest = { type: string; id: string; action: string; payload: unknown };
type DbResponseListener = (message: unknown) => void;

describe('worker database IPC adapter', () => {
  const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
  let responseListener: DbResponseListener | undefined;
  let request: DbRequest | undefined;

  afterEach(() => {
    if (responseListener) process.off('message', responseListener);
    if (originalSendDescriptor) {
      Object.defineProperty(process, 'send', originalSendDescriptor);
    } else {
      Reflect.deleteProperty(process, 'send');
    }
    responseListener = undefined;
    request = undefined;
  });

  it('sends worker database requests through IPC and resolves the matching response', async () => {
    const existingListeners = new Set(process.listeners('message'));
    process.send = ((message: unknown) => {
      const currentRequest = message as DbRequest;
      request = currentRequest;
      setImmediate(() => {
        responseListener?.({
          type: 'db:response',
          id: currentRequest.id,
          success: true,
          result: currentRequest.action === 'attachment:getImagesForSession'
            ? [
              { id: 'a-1', message_id: 'message-1', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/png', data: 'bytes-1', original_url: null, created_at: 10 },
              { id: 'a-2', message_id: 'message-1', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/jpeg', data: 'bytes-2', original_url: 'https://cdn.minimax.io/a.jpg', created_at: 11 },
              { id: 'a-3', message_id: 'message-2', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/png', data: 'bytes-3', original_url: null, created_at: 12 },
            ]
            : currentRequest.action === 'attachment:store'
              ? { success: true }
            : { id: 'session-1', title: 'from host' },
        });
      });
      return true;
    }) as typeof process.send;

    const { attachmentDb, sessionDb } = await import('../src/worker-db-client.js');
    responseListener = process
      .listeners('message')
      .find((listener) => !existingListeners.has(listener)) as
      | DbResponseListener
      | undefined;

    expect(responseListener).toBeDefined();
    await expect(sessionDb.get('session-1')).resolves.toEqual({
      id: 'session-1',
      title: 'from host',
    });
    expect(request).toMatchObject({
      type: 'db:request',
      action: 'session:get',
      payload: { id: 'session-1' },
    });

    await expect(attachmentDb.getImagesForSession('session-1')).resolves.toEqual(new Map([
      ['message-1', [
        { id: 'a-1', message_id: 'message-1', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/png', data: 'bytes-1', original_url: null, created_at: 10 },
        { id: 'a-2', message_id: 'message-1', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/jpeg', data: 'bytes-2', original_url: 'https://cdn.minimax.io/a.jpg', created_at: 11 },
      ]],
      ['message-2', [
        { id: 'a-3', message_id: 'message-2', session_id: 'session-1', attachment_type: 'image', mime_type: 'image/png', data: 'bytes-3', original_url: null, created_at: 12 },
      ]],
    ]));
    expect(request).toMatchObject({
      type: 'db:request',
      action: 'attachment:getImagesForSession',
      payload: { sessionId: 'session-1' },
    });

    const parsedDocument = {
      filename: 'scan.pdf',
      filePath: 'C:/workspace/scan.pdf',
      charCount: 2400,
      text: 'extracted page text',
      extractMethod: 'hybrid',
      imageChunks: [{ base64: 'preserved-image-bytes', mediaType: 'image/png' }],
    };
    await expect(attachmentDb.storeParsedDocument('message-2', 'session-1', parsedDocument))
      .resolves.toEqual({ success: true });
    expect(request).toMatchObject({
      type: 'db:request',
      action: 'attachment:store',
      payload: {
        messageId: 'message-2',
        sessionId: 'session-1',
        ...parsedDocument,
      },
    });
  });
});
