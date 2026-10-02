// Plan 583 / ISS-30: the pure IPC sender-trust decision.
import { describe, it, expect } from 'vitest';

import { evaluateTrustedSender } from '../trusted-sender';
import type { TrustedSenderConfig, TrustedSenderFacts } from '../trusted-sender';

const MAIN_ID = 1000;
const APP_ORIGIN = 'http://localhost:3000';

const OK_CONFIG: TrustedSenderConfig = {
  mainWindowId: MAIN_ID,
  allowedOrigins: [APP_ORIGIN],
};

const MAIN_FRAME: TrustedSenderFacts = {
  senderId: MAIN_ID,
  frameRoutingId: 0,
  frameUrl: `${APP_ORIGIN}/index.html`,
};

describe('evaluateTrustedSender', () => {
  it('accepts the main window main frame on the app origin', () => {
    expect(evaluateTrustedSender(MAIN_FRAME, OK_CONFIG)).toEqual({ ok: true });
  });

  it('refuses when no main window is open', () => {
    const verdict = evaluateTrustedSender(MAIN_FRAME, { ...OK_CONFIG, mainWindowId: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('unknown_window');
  });

  it('refuses an auxiliary window', () => {
    // Overlay, recorder badge, computer-use overlay and the Conductor
    // capture window all have their own webContents id.
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, senderId: 2000 }, OK_CONFIG);
    expect(verdict.ok === false && verdict.reason).toBe('unknown_window');
    expect(verdict.ok === false && verdict.detail).toContain('2000');
  });

  it('refuses a webview guest even when it reports the app origin', () => {
    // A guest is a separate webContents, so the sender id differs — which is
    // precisely why the id check is the one that matters for guests.
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, senderId: 3000 }, OK_CONFIG);
    expect(verdict.ok).toBe(false);
  });

  it('refuses an iframe inside the main window', () => {
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, frameRoutingId: 7 }, OK_CONFIG);
    expect(verdict.ok === false && verdict.reason).toBe('subframe');
  });

  it('refuses when the sender frame is unavailable', () => {
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, frameRoutingId: null }, OK_CONFIG);
    expect(verdict.ok === false && verdict.reason).toBe('subframe');
  });

  it('refuses a top frame that navigated off the app origin', () => {
    const verdict = evaluateTrustedSender(
      { ...MAIN_FRAME, frameUrl: 'https://evil.example/steal' },
      OK_CONFIG,
    );
    expect(verdict.ok === false && verdict.reason).toBe('foreign_origin');
  });

  it('refuses an opaque origin', () => {
    // `Origin: null` is what a sandboxed iframe or file:// document sends.
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, frameUrl: 'null' }, OK_CONFIG);
    expect(verdict.ok).toBe(false);
  });

  it('refuses an unparseable frame url', () => {
    const verdict = evaluateTrustedSender({ ...MAIN_FRAME, frameUrl: 'not a url' }, OK_CONFIG);
    expect(verdict.ok === false && verdict.reason).toBe('foreign_origin');
  });

  it('refuses when there is no app origin to compare against', () => {
    // Window not loaded yet: we cannot prove the document, so we refuse.
    const verdict = evaluateTrustedSender(MAIN_FRAME, { ...OK_CONFIG, allowedOrigins: [] });
    expect(verdict.ok === false && verdict.reason).toBe('foreign_origin');
  });

  it('accepts an explicitly allowed preview or dev origin', () => {
    const preview: TrustedSenderConfig = {
      mainWindowId: MAIN_ID,
      allowedOrigins: [APP_ORIGIN, 'http://localhost:4173'],
    };
    expect(
      evaluateTrustedSender({ ...MAIN_FRAME, frameUrl: 'http://localhost:4173/' }, preview).ok,
    ).toBe(true);
  });

  it('checks the sender before the frame, so a guest reads as unknown_window', () => {
    const verdict = evaluateTrustedSender(
      { senderId: 3000, frameRoutingId: 9, frameUrl: 'https://evil.example/' },
      OK_CONFIG,
    );
    expect(verdict.ok === false && verdict.reason).toBe('unknown_window');
  });
});
