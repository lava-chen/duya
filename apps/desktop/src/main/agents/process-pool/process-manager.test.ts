/**
 * apps/desktop/src/main/agents/process-pool/process-manager.test.ts
 *
 * The Desktop spawns the same 4.6 MB worker bundle the Host does, but
 * through its OWN code path (`getAgentRuntimeCommand`), not through the
 * Host's `createWorkerEnvironment`. So the compile cache has to be set on
 * both, or the Desktop silently keeps paying the compile on every spawn.
 *
 * The mechanism is an environment variable, so a missing one fails
 * silently -- the worker still starts, just slower. These assertions pin
 * the variable's presence, its stability, and the fact that an operator's
 * explicit choice is not overridden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getLocale: () => 'en-US', getLocaleCountryCode: () => 'US' },
}));

vi.mock('../../config/store-instance', () => ({
  getConfigStore: () => ({ getByPath: () => undefined }),
}));

import { getAgentRuntimeCommand } from './process-manager';

const ORIGINAL_CACHE_DIR = process.env.NODE_COMPILE_CACHE;

afterEach(() => {
  if (ORIGINAL_CACHE_DIR === undefined) {
    delete process.env.NODE_COMPILE_CACHE;
  } else {
    process.env.NODE_COMPILE_CACHE = ORIGINAL_CACHE_DIR;
  }
});

describe('the Desktop agent process compile cache', () => {
  it('gives the spawned agent a compile cache directory', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const runtime = getAgentRuntimeCommand('session-1');

    // Without this the Desktop worker recompiles the bundle from source
    // on every spawn, and nothing in the logs says so.
    expect(runtime.env.NODE_COMPILE_CACHE).toBeTruthy();
  });

  it('keeps the cache directory stable across spawns', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const first = getAgentRuntimeCommand('session-1');
    const second = getAgentRuntimeCommand('session-2');

    // A per-spawn directory would be a cold cache per spawn, which is the
    // cost this exists to remove.
    expect(second.env.NODE_COMPILE_CACHE).toBe(first.env.NODE_COMPILE_CACHE);
  });

  it('respects an explicit cache directory instead of overriding it', () => {
    process.env.NODE_COMPILE_CACHE = '/explicit/cache/dir';

    const runtime = getAgentRuntimeCommand('session-1');

    expect(runtime.env.NODE_COMPILE_CACHE).toBe('/explicit/cache/dir');
  });

  it('keeps the agent environment the worker needs', () => {
    delete process.env.NODE_COMPILE_CACHE;

    const runtime = getAgentRuntimeCommand('session-9');

    // The cache is an addition, not a replacement.
    expect(runtime.env.SESSION_ID).toBe('session-9');
    expect(runtime.env.DUYA_AGENT_MODE).toBe('true');
    expect(runtime.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
