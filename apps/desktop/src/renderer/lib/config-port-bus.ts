/**
 * Shared fan-out bus for the Electron config MessagePort.
 *
 * The preload exposes a single global callback per message type
 * (`onConfigUpdate` / `onConfigResponse`). This module owns that single
 * subscription and distributes events to any number of listeners, so
 * multiple features can react to config changes without overwriting each
 * other.
 */

type ConfigUpdateListener = (config: Record<string, unknown>) => void;
type ConfigResponseListener = (data: { key: string; value: unknown }) => void;

interface ConfigPort {
  getConfig: (key: string) => void;
  setConfig: (key: string, value: unknown) => void;
  onConfigUpdate: (handler: (config: unknown) => void) => () => void;
  /** Optional: older preload builds do not expose the response channel. */
  onConfigResponse?: (handler: (data: { key: string; value: unknown }) => void) => () => void;
}

const updateListeners = new Set<ConfigUpdateListener>();
const responseListeners = new Set<ConfigResponseListener>();

let port: ConfigPort | null = null;
let stopUpdate: (() => void) | undefined;
let stopResponse: (() => void) | undefined;

function getPort(): ConfigPort | null {
  if (typeof window === 'undefined') return null;
  if (port) return port;
  const api = window.electronAPI?.getConfigPort?.();
  if (!api) return null;
  port = api as ConfigPort;
  return port;
}

function ensureSubscribed(): void {
  const p = getPort();
  if (!p) return;

  // Subscribe each channel at most once while it is active; a channel is
  // re-established on demand after its last listener unsubscribes.
  if (!stopUpdate) {
    stopUpdate = p.onConfigUpdate((config) => {
      for (const listener of updateListeners) {
        listener(config as Record<string, unknown>);
      }
    });
  }

  if (!stopResponse && typeof p.onConfigResponse === 'function') {
    stopResponse = p.onConfigResponse((data) => {
      for (const listener of responseListeners) {
        listener(data);
      }
    });
  }
}

export function subscribeConfigUpdates(listener: ConfigUpdateListener): () => void {
  ensureSubscribed();
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
    if (updateListeners.size === 0) {
      stopUpdate?.();
      stopUpdate = undefined;
    }
  };
}

export function subscribeConfigResponses(listener: ConfigResponseListener): () => void {
  ensureSubscribed();
  responseListeners.add(listener);
  return () => {
    responseListeners.delete(listener);
    if (responseListeners.size === 0) {
      stopResponse?.();
      stopResponse = undefined;
    }
  };
}

export function getConfig(key: string): void {
  getPort()?.getConfig(key);
}

/**
 * Promise-based single-shot config read. Requests `key` over the config port
 * and resolves with its value (or `undefined` on timeout / no port). Used by
 * features that need a config value at call time (e.g. `agent.max_turns`).
 */
export function getConfigValue(key: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve) => {
    if (!getPort()) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const settle = (value: unknown): void => {
      if (settled) return;
      settled = true;
      unsub();
      clearTimeout(timer);
      resolve(value);
    };
    const unsub = subscribeConfigResponses((data) => {
      if (data.key === key) settle(data.value);
    });
    const timer = setTimeout(() => settle(undefined), timeoutMs);
    getConfig(key);
  });
}

export function setConfig(key: string, value: unknown): void {
  getPort()?.setConfig(key, value);
}
