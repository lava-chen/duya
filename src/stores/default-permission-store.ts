import { useSyncExternalStore } from 'react';
import {
  getConfig,
  subscribeConfigUpdates,
  subscribeConfigResponses,
} from '@/lib/config-port-bus';
import type { PermissionMode } from '@/components/chat/PermissionModeSelector';

/**
 * Singleton store for `agent.default_permission_mode` in config.toml.
 *
 * The default permission mode for new sessions is read from the config
 * MessagePort (flat key `defaultPermissionMode`), so WelcomeView and
 * NewChatView share one source of truth instead of hardcoding 'ask'.
 */

type Listener = () => void;

let currentValue: PermissionMode = 'ask';
const listeners = new Set<Listener>();
let unsubscribeUpdate: (() => void) | undefined;
let unsubscribeResponse: (() => void) | undefined;

function normalize(value: unknown): PermissionMode | null {
  if (value === 'auto' || value === 'bypass' || value === 'ask') return value;
  return null;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function ensureSubscribed(): void {
  if (unsubscribeUpdate || unsubscribeResponse) return;

  // The ConfigStore sends a full `config:update` when the port is registered,
  // so this fetch is mainly a defensive fallback for late subscribers.
  getConfig('defaultPermissionMode');

  unsubscribeUpdate = subscribeConfigUpdates((config) => {
    const next = normalize(config.defaultPermissionMode);
    if (next && next !== currentValue) {
      currentValue = next;
      emit();
    }
  });

  unsubscribeResponse = subscribeConfigResponses((data) => {
    if (data.key === 'defaultPermissionMode') {
      const next = normalize(data.value);
      if (next && next !== currentValue) {
        currentValue = next;
        emit();
      }
    }
  });
}

export function subscribeDefaultPermission(listener: Listener): () => void {
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

export function getDefaultPermissionSnapshot(): PermissionMode {
  return currentValue;
}

export function useDefaultPermission(): PermissionMode {
  return useSyncExternalStore(
    subscribeDefaultPermission,
    getDefaultPermissionSnapshot,
    () => currentValue,
  );
}