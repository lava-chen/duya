/**
 * electron/agents/__tests__/agent-communicator.channels.test.ts
 *
 * ISS-12: regression guard for the deleted `agent:getProviderConfig` channel.
 *
 * That handler returned `apiKey` in plaintext — twice, once at the top level
 * and again nested in `runtimeConfig.apiKey`. It had no callers and was not
 * exposed through the preload bridge, so deleting it was zero-risk. This test
 * exists so that re-adding it is a deliberate act with a failing test, not an
 * innocent-looking copy-paste.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../process-pool/agent-process-pool', () => ({
  getAgentProcessPool: () => ({ isRunning: () => false }),
}));
vi.mock('../agent-server-lifecycle', () => ({ getAgentServerPort: () => 0 }));
vi.mock('../../db/core-connection', () => ({ getCoreStores: () => ({ sessions: { get: () => null } }) }));
vi.mock('../../services/providers/provider-store-electron', () => ({
  getProviderStore: () => ({
    migrateAllLegacyProviders: () => {},
    getLlmProvider: () => null,
    getDefaultLlmProvider: () => null,
  }),
}));
vi.mock('../../config/store-instance', () => ({ getConfigStore: () => ({ getByPath: () => null }) }));
vi.mock('../db-bridge', () => ({
  dispatchDbAction: vi.fn(),
  handleDbRequest: vi.fn(),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  initLogger: vi.fn(),
  LogComponent: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import { registerAgentHandlers } from '../agent-communicator';

describe('registerAgentHandlers channel surface (ISS-12)', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    registerAgentHandlers();
  });

  it('does not register the plaintext provider-config channel', () => {
    expect(mocks.handlers.has('agent:getProviderConfig')).toBe(false);
  });

  it('pins the full provider channel surface, masked or not', () => {
    // Names are a poor proxy for "leaks a secret" — every `config:provider:*`
    // name matches /config/ on the prefix alone. So enumerate the surface
    // explicitly and say which of them hand back a live key. Adding or
    // removing any provider channel forces a deliberate edit here, which is
    // the point: this is a snapshot of a security-relevant surface, not a
    // heuristic.
    const registered = [...mocks.handlers.keys()]
      .filter((c) => c.startsWith('config:provider:') || c.endsWith('ProviderConfig'))
      .sort();

    // Returns a live `apiKey` to the renderer. Both are called from the
    // renderer today: stream-session-manager.ts:177 on every chat turn, and
    // ModelSelectionSection.tsx:218 for vision-model parsing. Removing them is
    // an architecture change, not a deletion — the renderer relays the key on
    // to the agent server. Tracked as an open item in the plan; listed here so
    // the set cannot silently grow a third entry.
    const UNMASKED = [
      'config:provider:getActiveProviderConfig',
      'config:provider:getConfig',
    ];
    // Masked or secret-free. `agent:getMaskedProviderConfig` is the sanctioned
    // shape and the reason the deleted channel was redundant as well as leaky.
    const MASKED_OR_SECRET_FREE = [
      'agent:getMaskedProviderConfig',
      'config:provider:activate',
      'config:provider:delete',
      'config:provider:get',
      'config:provider:getActive',
      'config:provider:getAll',
      'config:provider:update',
      'config:provider:upsert',
    ];

    expect(registered).toEqual([...UNMASKED, ...MASKED_OR_SECRET_FREE].sort());
  });

  it('keeps agent:getMaskedProviderConfig as the masked alternative', () => {
    // The reason the deleted channel was redundant as well as leaky: a
    // masked sibling already exists and is the shape callers should use.
    expect(mocks.handlers.has('agent:getMaskedProviderConfig')).toBe(true);
  });
});
