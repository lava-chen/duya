import { afterEach, describe, expect, it } from 'vitest';

type DbRequest = { type: string; id: string; action: string; payload: unknown };
type DbResponseListener = (message: unknown) => void;

// The pool's own `'message'` listeners, captured BEFORE the db client
// loads: it registers its own as an import side effect
// (`worker-db-client.ts:1251`), and under a pool worker the pool has one
// too. Calling THAT one would hand a plain object to the pool's
// deserializer, which is the crash this boundary exists to prevent.
const PRE_EXISTING = new Set(process.listeners('message'));

const { attachmentDb, sessionDb, setDbTransport } = await import('../src/worker-db-client.js');

const responseListener = process
  .listeners('message')
  .find((listener) => !PRE_EXISTING.has(listener)) as DbResponseListener | undefined;

let request: DbRequest | undefined;

describe('worker database IPC adapter', () => {
  afterEach(() => {
    // The transport is a module-level install, so it is uninstalled the same
    // way it was installed. There is no `process.send` left to restore: the
    // point of the seam is that the test never owns that global.
    setDbTransport(null);
    request = undefined;
  });

  it('sends worker database requests through IPC and resolves the matching response', async () => {
    // T04b: the channel is INSTALLED through the transport seam, and
    // `process.send` is no longer replaced.
    //
    // Replacing `process.send` used to be enough, and stopped being enough
    // the moment the db client learned to refuse the pool's channel: a
    // `process.send` swapped in BEFORE this module loaded is captured as the
    // module's `PRISTINE_SEND`, so it is indistinguishable from the pool's
    // own channel and the request is refused by name. Installing a
    // transport is the sanctioned way for a test to own the channel, and it
    // is the SAME channel the production path uses -- `process.send` with
    // the process as receiver -- so this file exercises the real seam and
    // not a private one.
    setDbTransport({
      send: (message) => {
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
      },
    });

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
