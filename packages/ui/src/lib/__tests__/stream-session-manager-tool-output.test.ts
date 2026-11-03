/**
 * Plan 636 -- the Desktop/Web half of a running command's output.
 *
 * `stream-session-manager` has carried `streamingToolOutput` and
 * `subscribeToToolOutput` for a while, and `ToolActionsGroup` still gates the
 * preview on `isRunning`: the render side was built, the producer was not. This
 * file is the producer -- one `tool_output` SSE frame arriving while a tool call
 * is still open -- and the contract it has to honour:
 *
 *  - the tail belongs to ONE call, and a slice for another call is dropped
 *    rather than appended to the wrong row;
 *  - it is bounded, keeping the END, because a command that prints forever must
 *    not grow the session;
 *  - the authoritative result supersedes it, so the tail clears when THAT call
 *    settles and not when a sibling does.
 *
 * Events are driven through the real SSE client (the same path the parser
 * feeds), so the `case 'tool_output'` arm in the manager's switch is covered
 * rather than bypassed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GLOBAL_KEY = '__stream_session_manager__';

/** One frame as the SSE client forwards it: `toolUseId` and `data` flat. */
type Frame = { toolUseId?: string; data?: string; stream?: 'stdout' | 'stderr' };

describe('stream session live tool output', () => {
  let manager: import('../stream-session-manager').StreamSessionManager;

  beforeEach(async () => {
    delete (globalThis as typeof globalThis & Record<string, unknown>)[GLOBAL_KEY];
    vi.resetModules();
    const mod = await import('../stream-session-manager');
    manager = new mod.StreamSessionManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as typeof globalThis & Record<string, unknown>)[GLOBAL_KEY];
  });

  /** Let the client's onEvent registration land before the first frame. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Start a stream whose body never advances, then feed frames through the
   * client's emit(). A body that flushed immediately would race the manager's
   * onEvent registration and drop every frame -- the reason is documented on
   * the same trick in `../stream-session-manager.test.ts`.
   */
  async function hangingStream(sessionId: string) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
          releaseLock: () => {},
        }),
      },
    } as unknown as Response));

    await manager.startStream({ sessionId, content: 'Run something' });
    await flush();

    const { getAgentServerClient } = await import('../agent-http-client');
    const client = getAgentServerClient();
    return (frame: Frame): void => {
      client['emit'](sessionId, {
        type: 'tool_output',
        sessionId,
        toolUseId: frame.toolUseId,
        stream: frame.stream,
        data: frame.data,
      });
    };
  }

  /**
   * Settle one call. Reached through the manager's own result handler rather
   * than a second SSE frame because the fact under test is the pairing --
   * which call id the result names -- and a frame would only re-test the switch.
   */
  function settle(sessionId: string, callId: string, content: string): void {
    const streamId = manager.getSnapshot(sessionId)?.streamId;
    // The handler ignores a frame whose stream is not the current one, so a
    // missing id here means the stream was never started — the test would
    // otherwise pass by settling nothing at all.
    if (typeof streamId !== 'string') throw new Error(`no live stream for ${sessionId}`);
    manager['handleToolResultEvent'](sessionId, streamId, {
      tool_use_id: callId,
      content,
      is_error: false,
    });
  }

  it('appends each slice, in order, and tells the subscriber each time', async () => {
    const emit = await hangingStream('tail-basic');
    const seen: string[] = [];
    const unsubscribe = manager.subscribeToToolOutput('tail-basic', (output) => {
      seen.push(output);
    });

    emit({ toolUseId: 'call-1', data: 'npm http GET https://registry.npmjs.org/a\n' });
    emit({ toolUseId: 'call-1', data: 'npm http 200 https://registry.npmjs.org/a\n' });

    expect(manager.getSnapshot('tail-basic')!.streamingToolOutput).toBe(
      'npm http GET https://registry.npmjs.org/a\nnpm http 200 https://registry.npmjs.org/a\n',
    );
    // One call per slice, plus the subscribe-time seed the API promises: the
    // preview is what a subscriber renders, and a notification that only fired
    // at the end would be a result, not a tail.
    expect(seen).toEqual([
      '',
      'npm http GET https://registry.npmjs.org/a\n',
      'npm http GET https://registry.npmjs.org/a\nnpm http 200 https://registry.npmjs.org/a\n',
    ]);
    unsubscribe();
  });

  it('belongs to one call, so a sibling slice cannot join the wrong row', async () => {
    const emit = await hangingStream('tail-owner');
    emit({ toolUseId: 'call-1', data: 'first command\n' });

    // A second command starts printing while the first is still open. Without
    // the owner check the two commands' bytes interleave into one preview under
    // whichever tool row the renderer happens to be drawing.
    emit({ toolUseId: 'call-2', data: 'second command\n' });

    expect(manager.getSnapshot('tail-owner')!.streamingToolOutput).toBe('first command\n');

    // And the owner is re-claimable after the tail clears.
    settle('tail-owner', 'call-1', 'first command\n');
    expect(manager.getSnapshot('tail-owner')!.streamingToolOutput).toBe('');

    emit({ toolUseId: 'call-2', data: 'second command\n' });
    expect(manager.getSnapshot('tail-owner')!.streamingToolOutput).toBe('second command\n');
  });

  it('keeps the end of a tail that outgrows the budget', async () => {
    const emit = await hangingStream('tail-cap');
    const line = `${'x'.repeat(199)}\n`; // 200 chars
    for (let i = 0; i < 200; i++) emit({ toolUseId: 'call-1', data: line });

    const tail = manager.getSnapshot('tail-cap')!.streamingToolOutput;
    expect(tail.length).toBe(30_000);
    // The END, not the beginning: a command that has printed 40 KB is being
    // judged on what it printed last.
    expect(tail).toBe(line.repeat(150));
  });

  it('clears when its own call settles, and not when a sibling does', async () => {
    const emit = await hangingStream('tail-settle');
    const seen: string[] = [];
    manager.subscribeToToolOutput('tail-settle', (output) => seen.push(output));
    emit({ toolUseId: 'call-1', data: 'still running\n' });

    // A different call finishing must not blank a preview that is still live --
    // batched tools settle out of order.
    settle('tail-settle', 'call-other', 'unrelated');
    expect(manager.getSnapshot('tail-settle')!.streamingToolOutput).toBe('still running\n');

    settle('tail-settle', 'call-1', 'still running\n');
    expect(manager.getSnapshot('tail-settle')!.streamingToolOutput).toBe('');
    expect(seen[seen.length - 1]).toBe('');
  });

  it('ignores a slice with no owner or no bytes', async () => {
    const emit = await hangingStream('tail-blank');
    emit({ data: 'orphan bytes' });
    emit({ toolUseId: 'call-1', data: '' });
    emit({ toolUseId: '', data: 'x' });

    expect(manager.getSnapshot('tail-blank')!.streamingToolOutput).toBe('');
  });

  it('hands a new stream an empty tail', async () => {
    const emit = await hangingStream('tail-reset');
    emit({ toolUseId: 'call-1', data: 'turn one output\n' });
    expect(manager.getSnapshot('tail-reset')!.streamingToolOutput).toBe('turn one output\n');

    // The next turn starts a new stream; the previous command's bytes are not
    // this turn's preview.
    await manager.startStream({ sessionId: 'tail-reset', content: 'Again' });
    await flush();
    expect(manager.getSnapshot('tail-reset')!.streamingToolOutput).toBe('');
  });
});
