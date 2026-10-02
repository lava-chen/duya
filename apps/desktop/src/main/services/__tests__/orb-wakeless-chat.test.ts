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
  buildWakelessRequestBody,
  selectScreenSource,
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

describe('startWakelessChat (no agent server in unit tests)', () => {
  it('rejects when the agent server is not running', async () => {
    // getAgentServerPort() is null outside the app — the pre-flight
    // rejection must fire before any fetch is attempted.
    const result = await startWakelessChat('hello');
    expect(result.accepted).toBe(false);
    expect(result.note).toContain('Agent server');
  });

  it('rejects before touching the network for long prompts too', async () => {
    const result = await startWakelessChat('a'.repeat(100));
    expect(result.accepted).toBe(false);
    expect(result.sessionId).toBeUndefined();
  });
});

describe('interruptWakelessChat (stub)', () => {
  it('does not throw for a wakeless sessionId', async () => {
    await expect(
      interruptWakelessChat('wakeless-00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
  });
});

describe('buildWakelessRequestBody (audit bug ③ — working directory)', () => {
  const providerConfig = { apiKey: 'x' } as Record<string, unknown>;
  const files = [{ id: '1', name: 'a.txt', type: 'text/plain', url: 'data:,a' }];

  it('includes workingDirectory + defaultWorkspaceDirectory when set', () => {
    const body = buildWakelessRequestBody({
      prompt: 'hi',
      providerConfig,
      files,
      workingDirectory: '/home/user/project',
    });
    expect(body.workingDirectory).toBe('/home/user/project');
    expect(body.defaultWorkspaceDirectory).toBe('/home/user/project');
    expect(body.prompt).toBe('hi');
    expect(body.providerConfig).toBe(providerConfig);
    expect(body.options).toEqual({ wakeless: true, files });
  });

  it('omits both directory keys when undefined (worker falls back to default cwd)', () => {
    const body = buildWakelessRequestBody({ prompt: 'hi', providerConfig, files });
    expect(body).not.toHaveProperty('workingDirectory');
    expect(body).not.toHaveProperty('defaultWorkspaceDirectory');
    expect(body.options).toEqual({ wakeless: true, files });
  });

  it('marks the turn as wakeless', () => {
    const body = buildWakelessRequestBody({ prompt: 'p', providerConfig, files: [] });
    expect((body.options as { wakeless: boolean }).wakeless).toBe(true);
  });
});

describe('selectScreenSource (audit bug ④ — multi-monitor capture)', () => {
  const mk = (id: string) => ({ display_id: id, id: `screen:${id}`, name: `Screen ${id}` });

  it('returns undefined when there are no sources', () => {
    expect(selectScreenSource([] as never, 1)).toBeUndefined();
  });

  it('returns the only source on a single-monitor setup regardless of displayId', () => {
    const src = mk('1') as never;
    expect(selectScreenSource([src], 1)).toBe(src);
    expect(selectScreenSource([src], null)).toBe(src);
  });

  it('picks the source whose display_id matches the cursor display', () => {
    const a = mk('1') as never;
    const b = mk('2') as never;
    expect(selectScreenSource([a, b], 2)).toBe(b);
    expect(selectScreenSource([a, b], 1)).toBe(a);
  });

  it('falls back to sources[0] when no source matches the display', () => {
    const a = mk('1') as never;
    const b = mk('2') as never;
    expect(selectScreenSource([a, b], 99)).toBe(a);
    expect(selectScreenSource([a, b], null)).toBe(a);
  });
});