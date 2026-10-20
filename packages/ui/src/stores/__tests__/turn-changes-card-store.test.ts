// Tests for turn-changes-card-store.ts — the settings switch behind
// TurnChangesCard (`display.turn_changes_card` in config.toml).
//
// The store is a module-level singleton wired to the config-port bus
// (same shape as link-opener-store). The bus mock is explicitly reset in
// beforeEach: `vi.resetModules()` refreshes the STORE module but mocked
// modules persist across resets, so without a manual reset the listener
// sets would accumulate across tests and make every count assertion lie.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface BusState {
  sent: Array<{ type: 'get' | 'set'; key: string; value?: unknown }>;
  updateListeners: Set<(config: Record<string, unknown>) => void>;
  responseListeners: Set<(data: { key: string; value: unknown }) => void>;
  reset: () => void;
}

vi.mock('@/lib/config-port-bus', () => {
  const bus: BusState = {
    sent: [],
    updateListeners: new Set(),
    responseListeners: new Set(),
    reset: () => {
      bus.sent.length = 0;
      bus.updateListeners.clear();
      bus.responseListeners.clear();
    },
  };
  return {
    getConfig: (key: string) => {
      bus.sent.push({ type: 'get', key });
    },
    setConfig: (key: string, value: unknown) => {
      bus.sent.push({ type: 'set', key, value });
    },
    subscribeConfigUpdates: (listener: (config: Record<string, unknown>) => void) => {
      bus.updateListeners.add(listener);
      return () => {
        bus.updateListeners.delete(listener);
      };
    },
    subscribeConfigResponses: (listener: (data: { key: string; value: unknown }) => void) => {
      bus.responseListeners.add(listener);
      return () => {
        bus.responseListeners.delete(listener);
      };
    },
    __bus: bus,
  };
});

async function loadStore() {
  vi.resetModules();
  return import('../turn-changes-card-store');
}

async function bus(): Promise<BusState> {
  const mod = (await import('@/lib/config-port-bus')) as unknown as { __bus: BusState };
  return mod.__bus;
}

beforeEach(async () => {
  (await bus()).reset();
});

describe('turn-changes-card-store', () => {
  it('defaults to enabled (the card shipped on; the switch is an opt-out)', async () => {
    const store = await loadStore();
    expect(store.getTurnChangesCardSnapshot()).toBe(true);
  });

  it('setTurnChangesCard(false) writes the flat config key and flips the snapshot', async () => {
    const store = await loadStore();
    store.setTurnChangesCard(false);
    expect(store.getTurnChangesCardSnapshot()).toBe(false);
    const state = await bus();
    expect(state.sent).toContainEqual({ type: 'set', key: 'turnChangesCard', value: false });
  });

  it('setTurnChangesCard(true) when already true does not emit', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    store.subscribeTurnChangesCard(listener);
    store.setTurnChangesCard(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('applies a boolean config:update broadcast', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    const unsub = store.subscribeTurnChangesCard(listener);
    const state = await bus();
    expect(state.updateListeners.size).toBe(1);
    for (const push of state.updateListeners) push({ turnChangesCard: false });
    expect(store.getTurnChangesCardSnapshot()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('applies a boolean config:response (single-shot read path)', async () => {
    const store = await loadStore();
    store.subscribeTurnChangesCard(vi.fn());
    const state = await bus();
    for (const push of state.responseListeners) push({ key: 'turnChangesCard', value: false });
    expect(store.getTurnChangesCardSnapshot()).toBe(false);
  });

  it('ignores non-boolean update payloads (defensive against corrupt config)', async () => {
    const store = await loadStore();
    store.subscribeTurnChangesCard(vi.fn());
    const state = await bus();
    for (const push of state.updateListeners) push({ turnChangesCard: 'nope' });
    for (const push of state.responseListeners) push({ key: 'turnChangesCard', value: undefined });
    expect(store.getTurnChangesCardSnapshot()).toBe(true);
  });

  it('unsubscribing the last listener tears down both bus channels', async () => {
    const store = await loadStore();
    const unsub = store.subscribeTurnChangesCard(vi.fn());
    const state = await bus();
    expect(state.updateListeners.size).toBe(1);
    expect(state.responseListeners.size).toBe(1);
    expect(state.sent.some((entry) => entry.type === 'get' && entry.key === 'turnChangesCard')).toBe(
      true,
    );
    unsub();
    expect(state.updateListeners.size).toBe(0);
    expect(state.responseListeners.size).toBe(0);
  });
});
