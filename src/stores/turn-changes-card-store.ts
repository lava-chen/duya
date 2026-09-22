import { useSyncExternalStore } from 'react';
import {
  getConfig,
  setConfig,
  subscribeConfigUpdates,
  subscribeConfigResponses,
} from '@/lib/config-port-bus';

/**
 * Singleton store for `display.turn_changes_card` — the settings switch
 * behind the turn-scoped file-change card (TurnChangesCard).
 *
 * When disabled, the card (and with it the round's undo / review / open
 * actions) stops rendering; the per-call tool rows above it are unaffected.
 * This mirrors ZCode's `toolGroupingChanges` setting ("分组文件更改"), with
 * one deliberate difference: ZCode defaults the grouping OFF, while duya
 * keeps the card ON by default because it has shipped that way since
 * plan 566 — the switch is an opt-out, not an opt-in.
 *
 * Uses the shared config-port bus so this feature coexists with other
 * config subscribers (e.g., provider updates) without overwriting the
 * preload's single global callback. Structured after
 * `link-opener-store.ts`, the boolean store this one is modelled on.
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
  getConfig('turnChangesCard');

  unsubscribeUpdate = subscribeConfigUpdates((config) => {
    const value = config.turnChangesCard;
    if (typeof value === 'boolean' && value !== currentValue) {
      currentValue = value;
      emit();
    }
  });

  unsubscribeResponse = subscribeConfigResponses((data) => {
    if (
      data.key === 'turnChangesCard' &&
      typeof data.value === 'boolean' &&
      data.value !== currentValue
    ) {
      currentValue = data.value;
      emit();
    }
  });
}

export function subscribeTurnChangesCard(listener: Listener): () => void {
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

export function getTurnChangesCardSnapshot(): boolean {
  return currentValue;
}

export function setTurnChangesCard(value: boolean): void {
  setConfig('turnChangesCard', value);
  if (value !== currentValue) {
    currentValue = value;
    emit();
  }
}

export function useTurnChangesCardEnabled(): boolean {
  return useSyncExternalStore(
    subscribeTurnChangesCard,
    getTurnChangesCardSnapshot,
    () => currentValue,
  );
}
