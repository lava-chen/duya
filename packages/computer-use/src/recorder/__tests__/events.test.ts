/**
 * events.test.ts — plan 556 Phase 0 Gate: schema correctness +
 * safe-parse resilience.
 *
 * Coverage:
 *   - Every event kind in the discriminated union round-trips.
 *   - Required fields are enforced (e.g. ElementDescriptor.source).
 *   - `safeParseRecorderEvent` swallows truncated / malformed lines
 *     and reports a parseable reason (NOT a thrown error) — the
 *     session-store depends on this to survive kill -9 mid-flush.
 */

import { describe, it, expect } from 'vitest';

import {
  AppRefSchema,
  ElementDescriptorSchema,
  RecorderEventSchema,
  safeParseRecorderEvent,
  RECORDER_EVENT_TYPES,
  type RecorderEvent,
} from '../events.js';

const APP = { name: 'Google Chrome', title: 'Example', processName: 'chrome', pid: 1234 };
const ELEMENT = { name: 'Submit', controlType: 'Button', source: 'uia-probe' as const };
const NO_ELEMENT = { source: 'none' as const };

describe('AppRefSchema', () => {
  it('accepts a minimal app reference', () => {
    expect(AppRefSchema.safeParse(APP).success).toBe(true);
  });
  it('rejects negative pids', () => {
    const bad = { ...APP, pid: -1 };
    expect(AppRefSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ElementDescriptorSchema', () => {
  it('requires source', () => {
    expect(ElementDescriptorSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
  it('accepts source-only element (probe missed)', () => {
    expect(ElementDescriptorSchema.safeParse({ source: 'none' }).success).toBe(true);
  });
  it('accepts full uia-probe element', () => {
    const full = {
      name: '登录',
      controlType: 'Edit',
      automationId: 'username',
      className: 'Edit',
      rect: { x: 10, y: 20, w: 100, h: 30 },
      isPassword: false,
      source: 'uia-probe' as const,
    };
    expect(ElementDescriptorSchema.safeParse(full).success).toBe(true);
  });
});

describe('RecorderEventSchema — discriminated union', () => {
  it('round-trips every event kind', () => {
    const samples: RecorderEvent[] = [
      { type: 'app_focus', ts: 1, app: APP, browserUrl: 'https://example.com' },
      { type: 'window_open', ts: 2, app: APP },
      { type: 'window_close', ts: 3, app: APP },
      { type: 'click', ts: 4, app: APP, click: { x: 50, y: 60, button: 'left', count: 1 }, element: ELEMENT },
      { type: 'type', ts: 5, app: APP, text: 'hello', element: ELEMENT },
      { type: 'key', ts: 6, app: APP, key: 'enter', modifiers: [] },
      { type: 'scroll', ts: 7, app: APP, direction: 'down', amount: 120 },
    ];
    for (const sample of samples) {
      const parsed = RecorderEventSchema.safeParse(sample);
      expect(parsed.success, sample.type).toBe(true);
    }
    expect(RECORDER_EVENT_TYPES).toHaveLength(7);
  });

  it('rejects an unknown discriminator', () => {
    const bad = { type: 'teleport', ts: 1, app: APP };
    expect(RecorderEventSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a click without element.source', () => {
    const bad = {
      type: 'click',
      ts: 1,
      app: APP,
      click: { x: 0, y: 0, button: 'left', count: 1 },
      element: { name: 'x' },
    };
    expect(RecorderEventSchema.safeParse(bad).success).toBe(false);
  });

  it('flags password fields via element.isPassword', () => {
    const passwordElement = { ...ELEMENT, controlType: 'Edit', isPassword: true };
    const event: RecorderEvent = {
      type: 'type',
      ts: 1,
      app: APP,
      text: 'supersecret',
      element: passwordElement,
    };
    const parsed = RecorderEventSchema.parse(event);
    expect(parsed.type).toBe('type');
    if (parsed.type === 'type') {
      expect(parsed.element.isPassword).toBe(true);
      // Schema preserves the original text — redaction is the privacy
      // module's job. This separation keeps the schema lossless.
      expect(parsed.text).toBe('supersecret');
    }
  });
});

describe('safeParseRecorderEvent', () => {
  it('rejects empty / whitespace lines', () => {
    expect(safeParseRecorderEvent('').ok).toBe(false);
    expect(safeParseRecorderEvent('   \n').ok).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const result = safeParseRecorderEvent('{"type":"click"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^json:/);
    }
  });

  it('rejects valid JSON that fails schema', () => {
    const result = safeParseRecorderEvent('{"type":"click"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/^schema:/);
    }
  });

  it('accepts a fully-valid event', () => {
    const json = JSON.stringify({
      type: 'type',
      ts: 1,
      app: APP,
      text: 'hi',
      element: NO_ELEMENT,
    });
    const result = safeParseRecorderEvent(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('type');
    }
  });
});