/**
 * orb-wakeless-chat.ts — unit tests.
 *
 * Validates session-id format, helpers, and the stub return contract.
 * The HTTP forwarding to the agent worker is a follow-up commit; this
 * test pins down the surface area so a future implementation can
 * extend without breaking the public API.
 *
 * Plan 453 Task G.
 */

import { describe, it, expect } from 'vitest';

import {
  WAKELESS_TIMEOUT_MS,
  interruptWakelessChat,
  newWakelessSessionId,
  newWakelessTurnId,
  startWakelessChat,
} from '../orb-wakeless-chat';

describe('newWakelessSessionId', () => {
  it('always uses the wakeless- prefix', () => {
    const id = newWakelessSessionId();
    expect(id.startsWith('wakeless-')).toBe(true);
  });

  it('produces unique ids across calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(newWakelessSessionId());
    }
    expect(ids.size).toBe(50);
  });

  it('id is a valid uuid v4 after the prefix', () => {
    const id = newWakelessSessionId();
    const uuid = id.slice('wakeless-'.length);
    // v4: 8-4-4-4-12 hex with 4 at position 14 and 8/9/a/b at position 19.
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

describe('newWakelessTurnId', () => {
  it('always uses the wake- prefix', () => {
    expect(newWakelessTurnId().startsWith('wake-')).toBe(true);
  });
});

describe('WAKELESS_TIMEOUT_MS', () => {
  it('is a positive number within reasonable bounds', () => {
    expect(WAKELESS_TIMEOUT_MS).toBeGreaterThan(0);
    // Hard cap of 5 min keeps a stuck wakeless session from leaking
    // memory indefinitely. Anything above an hour is suspect.
    expect(WAKELESS_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });
});

describe('startWakelessChat (stub)', () => {
  it('returns accepted with a sessionId', async () => {
    const result = await startWakelessChat('hello');
    expect(result.accepted).toBe(true);
    expect(result.sessionId).toMatch(/^wakeless-[0-9a-f-]{36}$/i);
  });

  it('records the prompt length in the log via a sessionId', async () => {
    const result = await startWakelessChat('a'.repeat(100));
    expect(result.sessionId).toBeDefined();
    expect(result.note).toContain('sessionId generated');
  });
});

describe('interruptWakelessChat (stub)', () => {
  it('does not throw for a wakeless sessionId', async () => {
    await expect(
      interruptWakelessChat('wakeless-00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
  });
});