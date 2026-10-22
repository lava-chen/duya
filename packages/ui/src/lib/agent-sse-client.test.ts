// @vitest-environment jsdom
/**
 * The compaction request's failure contract.
 *
 * `compactContext` is called without `await` and without a `.catch`, so every
 * failure it can produce has to arrive through `onError`. A rejected promise
 * there is an unhandled rejection AND a spinner that never stops — which is
 * what a Web user sees, because the Web has no agent server to compact
 * against at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactContext } from './agent-sse-client';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('compactContext', () => {
  it('reports a surface with no agent server through onError instead of rejecting', async () => {
    // No preload: the Web reaches the Host through its own BFF, and the
    // compaction route lives on the CLI's agent server, which the Web has no
    // address for.
    const onError = vi.fn();
    const onDone = vi.fn();

    await expect(compactContext('session-1', { onDone, onError })).resolves.toBeUndefined();

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('Agent server port');
  });

  it('reports a network failure through onError instead of rejecting', async () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      getAgentServerPort: async () => 51_234,
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const onError = vi.fn();

    await expect(compactContext('session-2', { onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('network down');
  });

  it('reports a refused request through onError instead of rejecting', async () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      getAgentServerPort: async () => 51_234,
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'compaction exploded',
    })));
    const onError = vi.fn();

    await expect(compactContext('session-3', { onError })).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('HTTP 500');
  });
});
