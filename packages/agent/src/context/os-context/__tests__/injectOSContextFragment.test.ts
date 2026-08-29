/**
 * injectOSContextFragment — unit tests.
 *
 * Drives the injection helper with a fake bridge to verify the
 * exact contract:
 *   - bridge disabled → no-op
 *   - bridge enabled but no current snapshot → no-op
 *   - runtimePromptMessageId null → no-op
 *   - target message not found → no-op
 *   - string content → wrapped into [{type:text}] before push
 *   - array content → block appended
 *   - returned boolean reflects whether injection happened
 *
 * Plan 453 Task C2.
 */

import { describe, it, expect } from 'vitest';

import { injectOSContextFragment } from '../fragment.js';
import { isContextualFragment } from '../../contextual-user-fragment.js';
import type { OSContext } from '../types.js';

const SAMPLE: OSContext = {
  schemaVersion: '0.4.0',
  capturedAt: '2026-08-28T00:00:00.000Z',
  focusedEntity: null,
  interactionTrail: [],
  intentCandidate: null,
  foreground: { pid: 1234, exeName: 'chrome.exe', title: 'GitHub' },
  redacted: false,
  redactionReason: null,
};

interface FakeBridge {
  isEnabled(): boolean;
  getCurrent(): OSContext | null;
}

function fakeBridge(opts: Partial<FakeBridge> = {}): FakeBridge {
  return {
    isEnabled: opts.isEnabled ?? (() => true),
    getCurrent: opts.getCurrent ?? (() => SAMPLE),
  };
}

describe('injectOSContextFragment', () => {
  it('returns false when runtimePromptMessageId is null', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    const ok = injectOSContextFragment(msgs, null, fakeBridge());
    expect(ok).toBe(false);
    expect(msgs[0].content).toBe('hello');
  });

  it('returns false when the bridge is disabled', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    const ok = injectOSContextFragment(msgs, 'u1', fakeBridge({
      isEnabled: () => false,
    }));
    expect(ok).toBe(false);
    expect(msgs[0].content).toBe('hello');
  });

  it('returns false when the bridge has no current snapshot', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    const ok = injectOSContextFragment(msgs, 'u1', fakeBridge({
      getCurrent: () => null,
    }));
    expect(ok).toBe(false);
    expect(msgs[0].content).toBe('hello');
  });

  it('returns false when the target message is not in messages', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    const ok = injectOSContextFragment(msgs, 'u2', fakeBridge());
    expect(ok).toBe(false);
    expect(msgs[0].content).toBe('hello');
  });

  it('wraps a string content into [{type:text}] and appends the fragment', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    const ok = injectOSContextFragment(msgs, 'u1', fakeBridge());
    expect(ok).toBe(true);
    expect(Array.isArray(msgs[0].content)).toBe(true);
    const arr = msgs[0].content as unknown as Array<{ type: string; text: string }>;
    expect(arr[0]).toEqual({ type: 'text', text: 'hello' });
    expect(arr[1].type).toBe('text');
    expect(arr[1].text).toContain('<external_os_context>');
    expect(arr[1].text).toContain('</external_os_context>');
  });

  it('appends to an existing array content without disturbing earlier blocks', () => {
    const msgs = [
      {
        id: 'u1',
        content: [{ type: 'text', text: 'hello' }],
      },
    ];
    const ok = injectOSContextFragment(msgs, 'u1', fakeBridge());
    expect(ok).toBe(true);
    const arr = msgs[0].content as unknown as Array<{ type: string; text: string }>;
    expect(arr[0].text).toBe('hello');
    expect(isContextualFragment(arr[1] as never)).toBe(true);
  });

  it('does not touch other messages in the array', () => {
    const msgs = [
      { id: 'sys', content: 'system prompt' },
      { id: 'u1', content: 'hello' },
      { id: 'u2', content: 'world' },
    ];
    const ok = injectOSContextFragment(msgs, 'u1', fakeBridge());
    expect(ok).toBe(true);
    expect(msgs[0].content).toBe('system prompt');
    expect(msgs[2].content).toBe('world');
    expect(Array.isArray(msgs[1].content)).toBe(true);
  });

  it('only injects into the message matching runtimePromptMessageId', () => {
    const msgs = [
      { id: 'u1', content: 'first user' },
      { id: 'u2', content: 'second user' },
    ];
    const ok = injectOSContextFragment(msgs, 'u2', fakeBridge());
    expect(ok).toBe(true);
    expect(msgs[0].content).toBe('first user');
    expect(Array.isArray(msgs[1].content)).toBe(true);
  });

  it('the rendered fragment round-trips through isContextualFragment', () => {
    const msgs = [{ id: 'u1', content: 'hello' }];
    injectOSContextFragment(msgs, 'u1', fakeBridge());
    const arr = msgs[0].content as unknown as Array<{ type: string }>;
    expect(isContextualFragment(arr[1] as never, 'os_context')).toBe(true);
  });
});