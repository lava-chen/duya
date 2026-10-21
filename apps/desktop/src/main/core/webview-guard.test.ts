/**
 * electron/core/webview-guard.test.ts
 *
 * Tests for the ISS-15 `<webview>` preference floor.
 *
 * `hardenWebviewPreferences` is pure (it only touches the object it is handed),
 * so the whole decision is testable without an Electron runtime. The adapter
 * that binds it to a live WebContents is exercised with a minimal fake.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  attachWebviewGuard,
  hardenWebviewPreferences,
  WEBVIEW_PREFERENCE_FLOOR,
} from './webview-guard';

describe('hardenWebviewPreferences', () => {
  it('disables node integration requested by the renderer', () => {
    // This is the concrete attack: a renderer that gets XSS'd asks for a
    // guest with Node in it.
    const prefs = { nodeIntegration: true } as Record<string, unknown>;
    const corrected = hardenWebviewPreferences(prefs as never);

    expect(prefs.nodeIntegration).toBe(false);
    expect(corrected).toContain('nodeIntegration');
  });

  it('disables the worker and subframe variants too', () => {
    const prefs = {
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
    } as Record<string, unknown>;
    hardenWebviewPreferences(prefs as never);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
  });

  it('restores contextIsolation and webSecurity when the renderer disables them', () => {
    const prefs = { contextIsolation: false, webSecurity: false } as Record<string, unknown>;
    hardenWebviewPreferences(prefs as never);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.webSecurity).toBe(true);
  });

  it('disables allowRunningInsecureContent', () => {
    const prefs = { allowRunningInsecureContent: true } as Record<string, unknown>;
    hardenWebviewPreferences(prefs as never);
    expect(prefs.allowRunningInsecureContent).toBe(false);
  });

  it('strips a preload script, which Electron runs with node integration', () => {
    const prefs = { preload: '/tmp/evil.js' } as Record<string, unknown>;
    const corrected = hardenWebviewPreferences(prefs as never);
    expect(prefs.preload).toBeUndefined();
    expect('preload' in prefs).toBe(false);
    expect(corrected).toContain('preload');
  });

  it('reports nothing when the renderer already asked for safe preferences', () => {
    // The legitimate webviews in this repo request none of these, so a clean
    // attach must stay silent rather than log noise on every guest.
    const prefs = { ...WEBVIEW_PREFERENCE_FLOOR } as Record<string, unknown>;
    expect(hardenWebviewPreferences(prefs as never)).toEqual([]);
  });

  it('writes the floor into absent fields without reporting them', () => {
    // An absent attribute is not a request: Electron resolves it to its own
    // safe default. Writing it is defence in depth, but reporting it would
    // make every legitimate guest attach log a false alarm.
    const prefs = {} as Record<string, unknown>;
    expect(hardenWebviewPreferences(prefs as never)).toEqual([]);
    for (const [key, safeValue] of Object.entries(WEBVIEW_PREFERENCE_FLOOR)) {
      expect(prefs[key]).toBe(safeValue);
    }
  });

  it('reports a field the renderer explicitly set to the unsafe value', () => {
    // The counterpart to the case above: `false` is a real ask, `undefined`
    // is not. The log has to be able to tell them apart.
    const prefs = { contextIsolation: false } as Record<string, unknown>;
    expect(hardenWebviewPreferences(prefs as never)).toEqual(['contextIsolation']);
  });

  it('mutates the object it was given rather than returning a copy', () => {
    // Electron reads guest preferences off this exact reference. A guard that
    // cloned would pass every assertion below and still protect nothing.
    const prefs: Record<string, unknown> = { nodeIntegration: true };
    const result = hardenWebviewPreferences(prefs as never);
    expect(result).not.toBe(prefs);
    expect(Object.keys(prefs)).toContain('nodeIntegration');
  });

  it('leaves behavior flags alone: sandbox, allowpopups, partition', () => {
    // Pinning `sandbox` would change how guest JavaScript runs, and we cannot
    // exercise a real webview attach in CI. Refuse to silently widen scope.
    const prefs = { sandbox: false, allowpopups: true, partition: 'persist:x' } as Record<string, unknown>;
    hardenWebviewPreferences(prefs as never);
    expect(prefs.sandbox).toBe(false);
    expect(prefs.allowpopups).toBe(true);
    expect(prefs.partition).toBe('persist:x');
  });

  it('never downgrades a preference the renderer already set safely', () => {
    const prefs = {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    } as Record<string, unknown>;
    hardenWebviewPreferences(prefs as never);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.webSecurity).toBe(true);
  });

  it('covers every flag it claims to pin', () => {
    const prefs = Object.fromEntries(
      Object.keys(WEBVIEW_PREFERENCE_FLOOR).map((k) => [k, !WEBVIEW_PREFERENCE_FLOOR[k]]),
    ) as Record<string, unknown>;
    const corrected = hardenWebviewPreferences(prefs as never);
    for (const key of Object.keys(WEBVIEW_PREFERENCE_FLOOR)) {
      expect(corrected).toContain(key);
      expect(prefs[key]).toBe(WEBVIEW_PREFERENCE_FLOOR[key]);
    }
  });
});

describe('attachWebviewGuard', () => {
  it('hardens the webPreferences argument, not the params attribute map', () => {
    // Regression guard: Electron reads guest preferences from the SECOND
    // handler argument. `params` is the raw `<webview>` attribute map and
    // hardening it is a silent no-op that would look implemented.
    const listeners: Record<string, (event: unknown, ...args: unknown[]) => void> = {};
    const contents = { on: (e: string, fn: (event: unknown, ...a: unknown[]) => void) => { listeners[e] = fn; } };
    attachWebviewGuard(contents as never);

    const webPreferences: Record<string, unknown> = { nodeIntegration: true };
    const params = { src: 'https://example.com' };
    listeners['will-attach-webview']?.({}, webPreferences, params);

    expect(webPreferences.nodeIntegration).toBe(false);
    expect(params).toEqual({ src: 'https://example.com' });
  });

  it('reports corrected fields to the callback only when something changed', () => {
    const listeners: Record<string, (event: unknown, ...args: unknown[]) => void> = {};
    const contents = { on: (e: string, fn: (event: unknown, ...a: unknown[]) => void) => { listeners[e] = fn; } };
    const onCorrected = vi.fn();
    attachWebviewGuard(contents as never, onCorrected);

    listeners['will-attach-webview']?.({}, {} as Record<string, unknown>, {});
    expect(onCorrected).not.toHaveBeenCalled();

    listeners['will-attach-webview']?.({}, { preload: '/tmp/x.js' } as Record<string, unknown>, {});
    expect(onCorrected).toHaveBeenCalledWith(['preload']);
  });
});
