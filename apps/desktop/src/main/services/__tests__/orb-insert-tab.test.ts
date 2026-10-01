/**
 * orb-insert-tab.ts — unit tests.
 *
 * Plan 453 Task I. The pure decision helper (decideInsertTab) is
 * tested directly; the nut.js path is mocked via a dynamic
 * import override.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    osContextBridge: {
      isEnabled: vi.fn(() => true),
      getCurrent: vi.fn(() => null as null | object),
    },
    keyboard: {
      type: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@duya/agent/context/os-context', () => ({
  getOSContextBridge: () => mocks.osContextBridge,
}));

// Lazy nut.js mock — the real package is heavy + native. We only need
// the surface that the service uses.
vi.mock('@nut-tree-fork/nut-js', () => ({
  keyboard: mocks.keyboard,
}));

import {
  decideInsertTab,
  insertTabToFocusedField,
} from '../orb-insert-tab';

const SAMPLE_TEXT: OSContextLike = {
  redacted: false,
  redactionReason: null,
  focusedEntity: { kind: 'Text' },
  foreground: { exeName: 'chrome.exe' },
};

type OSContextLike = Parameters<typeof decideInsertTab>[0];

function setContext(ctx: OSContextLike | null): void {
  mocks.osContextBridge.getCurrent.mockReturnValue(ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.osContextBridge.isEnabled.mockReturnValue(true);
  mocks.osContextBridge.getCurrent.mockReturnValue(null);
  mocks.keyboard.type.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('decideInsertTab', () => {
  it('rejects when ctx is null', () => {
    expect(decideInsertTab(null)).toEqual({
      ok: false,
      reason: 'no-os-context-snapshot',
    });
  });

  it('rejects when redacted', () => {
    expect(
      decideInsertTab({
        redacted: true,
        redactionReason: 'password-manager-foreground',
        focusedEntity: { kind: 'Text' },
      }),
    ).toEqual({ ok: false, reason: 'focused-field-redacted' });
  });

  it('rejects when focusedEntity is null', () => {
    expect(
      decideInsertTab({
        redacted: false,
        redactionReason: null,
        focusedEntity: null,
      }),
    ).toEqual({ ok: false, reason: 'no-focused-entity' });
  });

  it('rejects when focusedEntity.kind is not Text/StreamingText', () => {
    expect(
      decideInsertTab({
        redacted: false,
        redactionReason: null,
        focusedEntity: { kind: 'File' },
      }),
    ).toEqual({
      ok: false,
      reason: 'unsupported-focused-entity-kind:File',
    });
  });

  it('accepts when focusedEntity is Text', () => {
    expect(
      decideInsertTab({
        redacted: false,
        redactionReason: null,
        focusedEntity: { kind: 'Text' },
      }),
    ).toEqual({ ok: true });
  });

  it('accepts when focusedEntity is StreamingText', () => {
    expect(
      decideInsertTab({
        redacted: false,
        redactionReason: null,
        focusedEntity: { kind: 'StreamingText' },
      }),
    ).toEqual({ ok: true });
  });
});

describe('insertTabToFocusedField', () => {
  it('rejects when text is not a string', async () => {
    const r = await insertTabToFocusedField(
      123 as unknown as string,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('text-not-string');
  });

  it('returns ok immediately for empty text', async () => {
    setContext(SAMPLE_TEXT);
    const r = await insertTabToFocusedField('');
    expect(r).toEqual({ ok: true, method: 'nut.type', length: 0 });
    expect(mocks.keyboard.type).not.toHaveBeenCalled();
  });

  it('rejects when the OSContext bridge is disabled', async () => {
    mocks.osContextBridge.isEnabled.mockReturnValue(false);
    setContext(SAMPLE_TEXT);
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('os-context-bridge-disabled');
  });

  it('rejects when there is no current OSContext snapshot', async () => {
    setContext(null);
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-os-context-snapshot');
  });

  it('rejects redacted (password) fields', async () => {
    setContext({
      redacted: true,
      redactionReason: 'password-manager-foreground',
      focusedEntity: { kind: 'Text' },
      foreground: { exeName: 'chrome.exe' },
    });
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('focused-field-redacted');
    expect(mocks.keyboard.type).not.toHaveBeenCalled();
  });

  it('rejects when focused entity is missing', async () => {
    setContext({
      redacted: false,
      redactionReason: null,
      focusedEntity: null,
    });
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-focused-entity');
  });

  it('rejects unsupported focused-entity kinds', async () => {
    setContext({
      redacted: false,
      redactionReason: null,
      focusedEntity: { kind: 'Photo' },
    });
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported-focused-entity-kind:Photo');
  });

  it('types into a Text field and reports the typed length', async () => {
    setContext(SAMPLE_TEXT);
    const r = await insertTabToFocusedField('hello world');
    expect(r).toEqual({ ok: true, method: 'nut.type', length: 11 });
    expect(mocks.keyboard.type).toHaveBeenCalledWith(
      'hello world',
      expect.objectContaining({ delayMs: expect.any(Number) }),
    );
  });

  it('returns ok: false on a thrown nut.js error', async () => {
    setContext(SAMPLE_TEXT);
    mocks.keyboard.type.mockRejectedValueOnce(new Error('keyboard gone'));
    const r = await insertTabToFocusedField('hello');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nut-type-failed');
  });
});