import { useSyncExternalStore } from 'react';
import {
  getConfig,
  setConfig,
  subscribeConfigUpdates,
  subscribeConfigResponses,
} from '@/lib/config-port-bus';

/**
 * Singleton store for `browser.open_links_in_external_browser`.
 *
 * Uses the shared config-port bus so this feature coexists with other
 * config subscribers (e.g., provider updates) without overwriting the
 * preload's single global callback.
 */

type Listener = () => void;

let currentValue = true;
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
  getConfig('openLinksInExternalBrowser');

  unsubscribeUpdate = subscribeConfigUpdates((config) => {
    const value = config.openLinksInExternalBrowser;
    if (typeof value === 'boolean' && value !== currentValue) {
      currentValue = value;
      emit();
    }
  });

  unsubscribeResponse = subscribeConfigResponses((data) => {
    if (data.key === 'openLinksInExternalBrowser' && typeof data.value === 'boolean' && data.value !== currentValue) {
      currentValue = data.value;
      emit();
    }
  });
}

export function subscribeLinkOpener(listener: Listener): () => void {
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

export function getLinkOpenerSnapshot(): boolean {
  return currentValue;
}

export function setLinkOpener(value: boolean): void {
  setConfig('openLinksInExternalBrowser', value);
  if (value !== currentValue) {
    currentValue = value;
    emit();
  }
}

export function useLinkOpenerValue(): boolean {
  return useSyncExternalStore(
    subscribeLinkOpener,
    getLinkOpenerSnapshot,
    () => currentValue,
  );
}
