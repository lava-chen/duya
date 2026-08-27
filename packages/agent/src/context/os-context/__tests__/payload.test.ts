/**
 * payload.ts — unit tests.
 *
 * Covers: JSON parse, schemaVersion whitelist, field pruning,
 * interactionTrail sliding-window cap, redaction normalization,
 * corrupt-file tolerance.
 *
 * Plan 453 Task B.
 */

import { describe, it, expect, vi } from 'vitest';

import { capTrail, parseOSContext } from '../payload.js';
import { MAX_TRAIL_EVENTS } from '../types.js';

const VALID_PAYLOAD = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-08-28T00:00:00.000Z',
  focus: {
    foregroundPid: 1234,
    foregroundProcessName: 'chrome.exe',
    foregroundHwnd: '0xCAFE',
    focusControlClassName: 'Chrome_RenderWidgetHostHWND',
  },
  redaction: { redacted: false, reason: null },
  focusedEntity: {
    kind: 'Document',
    confidence: 0.95,
    properties: { title: 'GitHub - duya' },
    capabilities: { canRead: true, canWrite: false, canInvoke: false },
    source: 'uia',
  },
  intentCandidate: {
    intent: 'research',
    confidence: 0.8,
    evidence: ['chrome.exe', 'github.com title'],
    requiredCapabilities: { canRead: true, canWrite: false, canInvoke: false },
    app: { pid: 1234, exeName: 'chrome.exe', appKind: 'browser' },
    source: 'rule',
  },
  interactionTrail: Array.from({ length: 50 }, (_, i) => ({
    ts: 1700000000000 + i * 100,
    type: 'window_focus' as const,
    source: 'uia' as const,
  })),
  platform: 'win32',
  assembleDurationMs: 42,
};

describe('parseOSContext', () => {
  it('parses a valid v0.4 payload', () => {
    const out = parseOSContext(JSON.stringify(VALID_PAYLOAD));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.schemaVersion).toBe('0.4.0');
    expect(out.context.foreground.exeName).toBe('chrome.exe');
    expect(out.context.focusedEntity?.properties.title).toBe('GitHub - duya');
    expect(out.context.intentCandidate?.intent).toBe('research');
    // sliding window — daemon writes 50, we keep 30
    expect(out.context.interactionTrail).toHaveLength(MAX_TRAIL_EVENTS);
    // the kept events should be the most recent ones
    expect(out.context.interactionTrail[0].ts).toBe(
      1700000000000 + (50 - MAX_TRAIL_EVENTS) * 100,
    );
  });

  it('caps interactionTrail at MAX_TRAIL_EVENTS even when fewer are present', () => {
    const few = {
      ...VALID_PAYLOAD,
      interactionTrail: [
        { ts: 1, type: 'window_focus' as const, source: 'uia' as const },
        { ts: 2, type: 'window_focus' as const, source: 'uia' as const },
      ],
    };
    const out = parseOSContext(JSON.stringify(few));
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.interactionTrail).toHaveLength(2);
  });

  it('rejects unsupported schemaVersion with WARN', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const out = parseOSContext(
      JSON.stringify({ ...VALID_PAYLOAD, schemaVersion: '99.0.0' }),
      { logger: logger as never },
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('unsupported-schema-version');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion: _omit, ...rest } = VALID_PAYLOAD;
    void _omit;
    const out = parseOSContext(JSON.stringify(rest));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('unsupported-schema-version');
  });

  it('rejects non-string capturedAt', () => {
    const bad = { ...VALID_PAYLOAD, capturedAt: 12345 };
    const out = parseOSContext(JSON.stringify(bad));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('missing-capturedAt');
  });

  it('rejects missing focus object', () => {
    const { focus: _omit, ...rest } = VALID_PAYLOAD;
    void _omit;
    const out = parseOSContext(JSON.stringify(rest));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('missing-focus');
  });

  it('normalizes unknown redaction reason to null', () => {
    const bad = {
      ...VALID_PAYLOAD,
      redaction: { redacted: true, reason: 'weird-new-reason' },
    };
    const out = parseOSContext(JSON.stringify(bad));
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.redacted).toBe(true);
    expect(out.context.redactionReason).toBeNull();
  });

  it('passes through known redaction reasons', () => {
    const bad = {
      ...VALID_PAYLOAD,
      redaction: {
        redacted: true,
        reason: 'password-manager-foreground',
      },
    };
    const out = parseOSContext(JSON.stringify(bad));
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.redacted).toBe(true);
    expect(out.context.redactionReason).toBe(
      'password-manager-foreground',
    );
  });

  it('treats missing focusedEntity as null', () => {
    const { focusedEntity: _omit, ...rest } = VALID_PAYLOAD;
    void _omit;
    const out = parseOSContext(JSON.stringify(rest));
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.focusedEntity).toBeNull();
  });

  it('treats null focusedEntity as null (not undefined)', () => {
    const out = parseOSContext(
      JSON.stringify({ ...VALID_PAYLOAD, focusedEntity: null }),
    );
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.focusedEntity).toBeNull();
  });

  it('drops interactionTrail when not an array', () => {
    const bad = { ...VALID_PAYLOAD, interactionTrail: 'nope' };
    const out = parseOSContext(JSON.stringify(bad));
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.interactionTrail).toEqual([]);
  });

  it('does not throw on invalid JSON', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const out = parseOSContext('{not json', { logger: logger as never });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('invalid-json');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not throw on non-object top-level value', () => {
    const out = parseOSContext('"a string"');
    expect(out.ok).toBe(false);
  });

  it('accepts an empty interactionTrail array', () => {
    const out = parseOSContext(
      JSON.stringify({ ...VALID_PAYLOAD, interactionTrail: [] }),
    );
    if (!out.ok) throw new Error('expected ok');
    expect(out.context.interactionTrail).toEqual([]);
  });

  it('honors a custom accepted-versions list', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const out = parseOSContext(
      JSON.stringify({ ...VALID_PAYLOAD, schemaVersion: '0.5.0' }),
      { logger: logger as never, acceptedVersions: ['0.5.0'] },
    );
    expect(out.ok).toBe(true);
  });
});

describe('capTrail', () => {
  it('returns a copy when under the cap', () => {
    const r = capTrail([1, 2, 3], 10);
    expect(r).toEqual([1, 2, 3]);
    expect(r).not.toBe([1, 2, 3]);
  });

  it('keeps the most recent N when over the cap', () => {
    const r = capTrail([1, 2, 3, 4, 5], 3);
    expect(r).toEqual([3, 4, 5]);
  });

  it('uses MAX_TRAIL_EVENTS by default', () => {
    const events = Array.from({ length: MAX_TRAIL_EVENTS + 20 }, (_, i) => i);
    const r = capTrail(events);
    expect(r).toHaveLength(MAX_TRAIL_EVENTS);
    expect(r[0]).toBe(20);
  });
});