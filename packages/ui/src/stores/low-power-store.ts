import { useSyncExternalStore } from 'react';
import {
  getConfig,
  setConfig,
  subscribeConfigUpdates,
  subscribeConfigResponses,
} from '@/lib/config-port-bus';

/**
 * Singleton store for `performance.lowPower` (plan 426 Phase 3).
 *
 * Mirrors the link-opener-store pattern over the shared config-port bus.
 * The configured mode ('auto' | 'on' | 'off') comes from ConfigStore;
 * 'auto' is resolved on the renderer with hardware heuristics
 * (hardwareConcurrency / deviceMemory). The main process resolves 'auto'
 * authoritatively with os.totalmem — renderer-side effects (polling
 * slowdown, backdrop-filter downgrade) only need an approximation.
 *
 * Also toggles `data-lowpower` on <html> so globals.css can downgrade
 * expensive backdrop-filter effects (plan 426 Phase 5.3).
 */

export type LowPowerMode = 'auto' | 'on' | 'off';

type Listener = () => void;

function detectLowSpecRenderer(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  // navigator.deviceMemory is Chromium-only, capped at 8 (GiB) — so a
  // reading below 8 reliably means <8GB total.
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory;
  return cores <= 4 || (typeof mem === 'number' && mem < 8);
}

export function resolveLowPowerRenderer(mode: LowPowerMode | undefined): boolean {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return detectLowSpecRenderer();
}

let currentMode: LowPowerMode = 'auto';
let currentEnabled = resolveLowPowerRenderer('auto');
const listeners = new Set<Listener>();
let unsubscribeUpdate: (() => void) | undefined;
let unsubscribeResponse: (() => void) | undefined;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function applyMode(mode: LowPowerMode): void {
  const enabled = resolveLowPowerRenderer(mode);
  if (mode === currentMode && enabled === currentEnabled) return;
  currentMode = mode;
  currentEnabled = enabled;
  if (typeof document !== 'undefined') {
    if (enabled) document.documentElement.setAttribute('data-lowpower', '1');
    else document.documentElement.removeAttribute('data-lowpower');
  }
  emit();
}

function readMode(value: unknown): LowPowerMode | undefined {
  if (value && typeof value === 'object' && 'lowPower' in value) {
    const v = (value as { lowPower: unknown }).lowPower;
    if (v === 'auto' || v === 'on' || v === 'off') return v;
  }
  return undefined;
}

function ensureSubscribed(): void {
  if (unsubscribeUpdate || unsubscribeResponse) return;

  // ConfigStore pushes a full `config:update` on port registration, so
  // this single-shot fetch is a defensive fallback for late subscribers.
  getConfig('performanceSettings');

  unsubscribeUpdate = subscribeConfigUpdates((config) => {
    const mode = readMode(config.performanceSettings);
    if (mode) applyMode(mode);
  });

  unsubscribeResponse = subscribeConfigResponses((data) => {
    if (data.key !== 'performanceSettings') return;
    const mode = readMode(data.value);
    if (mode) applyMode(mode);
  });
}

export function subscribeLowPower(listener: Listener): () => void {
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

export function getLowPowerModeSnapshot(): LowPowerMode {
  return currentMode;
}

export function getLowPowerSnapshot(): boolean {
  return currentEnabled;
}

export function setLowPowerMode(mode: LowPowerMode): void {
  setConfig('performanceSettings', { lowPower: mode });
  applyMode(mode);
}

/** Effective low-power state for renderer effects (polling ×4 etc.). */
export function useLowPower(): boolean {
  return useSyncExternalStore(
    subscribeLowPower,
    getLowPowerSnapshot,
    () => currentEnabled,
  );
}

/** Configured mode ('auto' | 'on' | 'off') for the settings UI. */
export function useLowPowerMode(): LowPowerMode {
  return useSyncExternalStore(
    subscribeLowPower,
    getLowPowerModeSnapshot,
    () => currentMode,
  );
}
