import { useSyncExternalStore } from 'react';
import {
  getConfig,
  setConfig,
  subscribeConfigUpdates,
  subscribeConfigResponses,
} from '@/lib/config-port-bus';

/**
 * Singleton store for `agent.busy_message_mode`.
 *
 * Chooses the default handling of a chat message sent while the agent is
 * already running: 'followup' injects it at the next model-turn boundary
 * (steering); 'queued' holds it until just before the final answer, or
 * promotes it to a fresh user turn when the run ends. Mirrors the mailbox
 * row `kind` vocabulary.
 *
 * Uses the shared config-port bus so this feature coexists with other
 * config subscribers (e.g., provider updates) without overwriting the
 * preload's single global callback.
 */

export type BusyMessageMode = 'followup' | 'queued';

type Listener = () => void;

function isBusyMessageMode(value: unknown): value is BusyMessageMode {
  return value === 'followup' || value === 'queued';
}

let currentValue: BusyMessageMode = 'queued';
const listeners = new Set<Listener>();
let unsubscribeUpdate: (() => void) | undefined;
let unsubscribeResponse: (() => void) | undefined;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function ensureSubscribed(): void {
  if (unsubscribeUpdate || unsubscribeResponse) return;

  // The ConfigStore sends a full `config:update` when the port is registered,
  // so this fetch is mainly a defensive fallback for late subscribers.
  getConfig('busyMessageMode');

  unsubscribeUpdate = subscribeConfigUpdates((config) => {
    const value = config.busyMessageMode;
    if (isBusyMessageMode(value) && value !== currentValue) {
      currentValue = value;
      emit();
    }
  });

  unsubscribeResponse = subscribeConfigResponses((data) => {
    if (
      data.key === 'busyMessageMode' &&
      isBusyMessageMode(data.value) &&
      data.value !== currentValue
    ) {
      currentValue = data.value;
      emit();
    }
  });
}

export function subscribeBusyMessageMode(listener: Listener): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeUpdate?.();
      unsubscribeResponse?.();
      unsubscribeUpdate = undefined;
      unsubscribeResponse = undefined;
    }
  };
}

export function getBusyMessageModeSnapshot(): BusyMessageMode {
  return currentValue;
}

export function setBusyMessageMode(value: BusyMessageMode): void {
  setConfig('busyMessageMode', value);
  if (value !== currentValue) {
    currentValue = value;
    emit();
  }
}

export function useBusyMessageModeValue(): BusyMessageMode {
  return useSyncExternalStore(
    subscribeBusyMessageMode,
    getBusyMessageModeSnapshot,
    () => currentValue,
  );
}
