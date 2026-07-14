import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GLOBAL_KEY = '__stream_session_manager__';

describe('stream session queued user messages', () => {
  beforeEach(() => {
    delete (globalThis as typeof globalThis & Record<string, unknown>)[GLOBAL_KEY];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & Record<string, unknown>)[GLOBAL_KEY];
  });

  it('promotes and starts queued mailbox rows in FIFO order', async () => {
    const { streamSessionManager } = await import('../../../src/lib/stream-session-manager');
    const promoteQueued = vi.fn(async (id: string) => ({
      id,
      content: `server:${id}`,
      attachments_json: null,
    }));
    vi.stubGlobal('window', { electronAPI: { mailbox: { promoteQueued } } });
    const start = vi.spyOn(streamSessionManager, 'startStream').mockResolvedValue({
      streamId: 'queued-stream',
      generation: 0,
    });

    streamSessionManager.enqueueMessage('queue-session', {
      sessionId: 'queue-session',
      content: 'client:first',
      queuedMailboxId: 'first',
    });
    streamSessionManager.enqueueMessage('queue-session', {
      sessionId: 'queue-session',
      content: 'client:second',
      queuedMailboxId: 'second',
    });

    const manager = streamSessionManager as unknown as {
      autoStartQueuedStream: (sessionId: string) => void;
    };
    manager.autoStartQueuedStream('queue-session');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(promoteQueued).toHaveBeenNthCalledWith(1, 'first');
    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      content: 'server:first',
      queuedMailboxId: 'first',
    }));

    manager.autoStartQueuedStream('queue-session');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(promoteQueued).toHaveBeenNthCalledWith(2, 'second');
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      content: 'server:second',
      queuedMailboxId: 'second',
    }));
  });

  it('skips a queued row already absorbed by the agent and starts the next one', async () => {
    const { streamSessionManager } = await import('../../../src/lib/stream-session-manager');
    const promoteQueued = vi.fn(async (id: string) => (
      id === 'guided' ? null : { id, content: `server:${id}` }
    ));
    vi.stubGlobal('window', { electronAPI: { mailbox: { promoteQueued } } });
    const start = vi.spyOn(streamSessionManager, 'startStream').mockResolvedValue({
      streamId: 'queued-stream',
      generation: 0,
    });
    streamSessionManager.enqueueMessage('skip-session', {
      sessionId: 'skip-session',
      content: 'guided',
      queuedMailboxId: 'guided',
    });
    streamSessionManager.enqueueMessage('skip-session', {
      sessionId: 'skip-session',
      content: 'next',
      queuedMailboxId: 'next',
    });

    (streamSessionManager as unknown as {
      autoStartQueuedStream: (sessionId: string) => void;
    }).autoStartQueuedStream('skip-session');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(promoteQueued).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      content: 'server:next',
      queuedMailboxId: 'next',
    }));
  });

  it('cancels durable mailbox rows when the user clears the queue', async () => {
    const { streamSessionManager } = await import('../../../src/lib/stream-session-manager');
    const cancel = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', { electronAPI: { mailbox: { cancel } } });
    streamSessionManager.enqueueMessage('clear-session', {
      sessionId: 'clear-session',
      content: 'first',
      queuedMailboxId: 'first',
    });
    streamSessionManager.enqueueMessage('clear-session', {
      sessionId: 'clear-session',
      content: 'second',
      queuedMailboxId: 'second',
    });

    streamSessionManager.clearQueuedMessages('clear-session');

    expect(streamSessionManager.hasQueuedMessages('clear-session')).toBe(false);
    expect(cancel).toHaveBeenNthCalledWith(1, 'first', 'queued_messages_cleared');
    expect(cancel).toHaveBeenNthCalledWith(2, 'second', 'queued_messages_cleared');
  });
});
