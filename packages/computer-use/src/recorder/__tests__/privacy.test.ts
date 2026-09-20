/**
 * privacy.test.ts — plan 556 Phase 0 Gate: password redaction +
 * process blacklist.
 *
 * Coverage:
 *   - DEFAULT_BLOCKED_PROCESS_NAMES covers the mainstream password
 *     managers (sanity, not exhaustive).
 *   - shouldDropEventForApp is case-insensitive and tolerates the
 *     `.exe` suffix Windows tools sometimes attach.
 *   - redactRecorderEvent rewrites text on password `type` events
 *     but leaves non-password events untouched (a click on a
 *     password button is still recorded — only the keystrokes are
 *     hidden).
 *   - Non-`type` events always pass through.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BLOCKED_PROCESS_NAMES,
  REDACTED_TEXT,
  redactRecorderEvent,
  shouldDropEventForApp,
} from '../privacy.js';
import type { RecorderEvent } from '../events.js';

const APP = { name: 'Google Chrome', title: 'Example', processName: 'chrome', pid: 1 };
const NO_ELEMENT = { source: 'none' as const };

describe('DEFAULT_BLOCKED_PROCESS_NAMES', () => {
  it('covers the major password managers', () => {
    expect(DEFAULT_BLOCKED_PROCESS_NAMES).toEqual(
      expect.arrayContaining([
        '1password',
        'bitwarden',
        'keepass',
        'keepassxc',
        'lastpass',
        'dashlane',
      ]),
    );
  });
});

describe('shouldDropEventForApp', () => {
  it('matches case-insensitively', () => {
    expect(shouldDropEventForApp({ processName: 'BITWARDEN' })).toBe(true);
    expect(shouldDropEventForApp({ processName: 'Bitwarden' })).toBe(true);
  });

  it('tolerates a trailing .exe suffix', () => {
    expect(shouldDropEventForApp({ processName: '1password.exe' })).toBe(true);
  });

  it('passes ordinary apps through', () => {
    expect(shouldDropEventForApp({ processName: 'chrome' })).toBe(false);
    expect(shouldDropEventForApp({ processName: 'notepad' })).toBe(false);
  });

  it('respects a custom blacklist', () => {
    expect(
      shouldDropEventForApp({ processName: 'minecraft' }, ['minecraft']),
    ).toBe(true);
    // Original defaults still apply for a partial override because
    // the recorder-service concatenates, not replaces — sanity check
    // that the function itself is purely intersection-free.
    expect(
      shouldDropEventForApp({ processName: '1password' }, ['minecraft']),
    ).toBe(false);
  });
});

describe('redactRecorderEvent', () => {
  it('rewrites text on a password `type` event', () => {
    const event: RecorderEvent = {
      type: 'type',
      ts: 1,
      app: APP,
      text: 'hunter2',
      element: {
        source: 'uia-probe',
        controlType: 'Edit',
        isPassword: true,
      },
    };
    const redacted = redactRecorderEvent(event);
    expect(redacted.type).toBe('type');
    if (redacted.type === 'type') {
      expect(redacted.text).toBe(REDACTED_TEXT);
      expect(redacted.text).not.toBe('hunter2');
      // The element descriptor is preserved so the converter can
      // mark the node with paramHint: true (design doc §4.6).
      expect(redacted.element.isPassword).toBe(true);
    }
  });

  it('leaves non-password `type` events untouched', () => {
    const event: RecorderEvent = {
      type: 'type',
      ts: 1,
      app: APP,
      text: 'public-value',
      element: { source: 'uia-probe', controlType: 'Edit' },
    };
    const redacted = redactRecorderEvent(event);
    expect(redacted).toBe(event);
  });

  it('passes click events through unchanged', () => {
    const event: RecorderEvent = {
      type: 'click',
      ts: 1,
      app: APP,
      click: { x: 10, y: 20, button: 'left', count: 1 },
      element: { source: 'uia-probe', controlType: 'Button', name: '登录' },
    };
    expect(redactRecorderEvent(event)).toBe(event);
  });

  it('passes key events through unchanged', () => {
    const event: RecorderEvent = {
      type: 'key',
      ts: 1,
      app: APP,
      key: 'enter',
      modifiers: [],
    };
    expect(redactRecorderEvent(event)).toBe(event);
  });
});

// Keep the unused import warning quiet — NO_ELEMENT is intentional as
// a baseline for future redaction-shape tests.
void NO_ELEMENT;