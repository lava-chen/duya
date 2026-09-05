/**
 * Plan 481 amendment tests: update_state profile.set / avatar.set /
 * avatar.clear subactions (identity routing through the bot-identity
 * bridge) + regression coverage for the memory/project paths untouched
 * by the amendment.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveUpdateStateOperation,
  setBotIdentityBridge,
  updateStateTool,
  type BotIdentityPatchPayload,
} from '../index.js';
import type { ToolUseContext } from '../../../types.js';

afterEach(() => {
  setBotIdentityBridge(null);
});

// ─── Resolution: profile.set ────────────────────────────────────────────────

describe('resolveUpdateStateOperation — profile.set', () => {
  it('accepts name only', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'profile',
      action: 'set',
      name: 'Night Ops',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && 'identity' in resolved) {
      expect(resolved.identity.subaction).toBe('profile.set');
      expect(resolved.identity.name).toBe('Night Ops');
      expect(resolved.identity.description).toBeUndefined();
    }
  });

  it('accepts description only', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'profile',
      action: 'set',
      description: 'Keeps the build green.',
    });
    expect(resolved.ok).toBe(true);
  });

  it('clamps name to 64 and description to 300 chars', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'profile',
      action: 'set',
      name: 'x'.repeat(80),
      description: 'y'.repeat(400),
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && 'identity' in resolved) {
      expect(resolved.identity.name?.length).toBe(64);
      expect(resolved.identity.description?.length).toBe(300);
    }
  });

  it('rejects when neither name nor description is given', () => {
    const resolved = resolveUpdateStateOperation({ target: 'profile', action: 'set' });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('INVALID_INPUT');
  });

  it('rejects non-set actions on target=profile', () => {
    const resolved = resolveUpdateStateOperation({ target: 'profile', action: 'clear', name: 'x' });
    expect(resolved.ok).toBe(false);
  });

  it('rejects a shared scope on identity targets', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'profile',
      scope: 'user',
      action: 'set',
      name: 'x',
    });
    expect(resolved.ok).toBe(false);
  });
});

// ─── Resolution: avatar.set / avatar.clear ──────────────────────────────────

describe('resolveUpdateStateOperation — avatar', () => {
  it('accepts image path and color', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'avatar',
      action: 'set',
      avatarImagePath: '/home/u/.duya/media/generated/avatar.png',
      avatarColor: 'violet',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && 'identity' in resolved) {
      expect(resolved.identity.subaction).toBe('avatar.set');
      expect(resolved.identity.avatarImagePath).toBe('/home/u/.duya/media/generated/avatar.png');
      expect(resolved.identity.avatarColor).toBe('violet');
    }
  });

  it('accepts color only', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'avatar',
      action: 'set',
      avatarColor: 'cyan',
    });
    expect(resolved.ok).toBe(true);
  });

  it('rejects avatar.set with no fields', () => {
    const resolved = resolveUpdateStateOperation({ target: 'avatar', action: 'set' });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('INVALID_INPUT');
  });

  it('accepts avatar.clear with no fields', () => {
    const resolved = resolveUpdateStateOperation({ target: 'avatar', action: 'clear' });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && 'identity' in resolved) {
      expect(resolved.identity.subaction).toBe('avatar.clear');
    }
  });

  it('rejects invalid actions on target=avatar', () => {
    const resolved = resolveUpdateStateOperation({ target: 'avatar', action: 'write' });
    expect(resolved.ok).toBe(false);
  });
});

// ─── Regression: memory path untouched ─────────────────────────────────────

describe('resolveUpdateStateOperation — memory regression', () => {
  it('still resolves memory writes without an identity member', () => {
    const resolved = resolveUpdateStateOperation({
      target: 'memory',
      scope: 'agent',
      action: 'write',
      fact: 'Prefers concise replies.',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect('identity' in resolved).toBe(false);
  });

  it('unknown targets now list all four in the error', () => {
    const resolved = resolveUpdateStateOperation({ target: 'songs', action: 'write' });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("'profile'");
  });
});

// ─── Permissions + execute: identity bridge routing ────────────────────────

function makeContext(overrides: Partial<{ agentProfileId: string | null }> = {}): ToolUseContext {
  return {
    toolUseId: 't-test',
    getAppState: (() => ({})) as ToolUseContext['getAppState'],
    setAppState: () => {},
    abortController: new AbortController(),
    options: {
      tools: [],
      commands: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
      agentProfileId:
        'agentProfileId' in overrides ? overrides.agentProfileId : 'night-ops',
      sessionId: 'bot:night-ops',
    },
  } as unknown as ToolUseContext;
}

describe('UpdateStateTool.execute — identity subactions', () => {
  it('routes profile.set through the identity bridge with actor identity', async () => {
    const calls: BotIdentityPatchPayload[] = [];
    setBotIdentityBridge(async (payload) => {
      calls.push(payload);
      return { success: true, result: { agentId: payload.actorAgentId, name: payload.name } };
    });

    const result = await updateStateTool.execute(
      { target: 'profile', action: 'set', name: 'Night Ops' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.result) as { success: boolean; subaction?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.subaction).toBe('profile.set');
    expect(calls).toHaveLength(1);
    expect(calls[0].actorAgentId).toBe('night-ops');
    expect(calls[0].subaction).toBe('profile.set');
    expect(calls[0].name).toBe('Night Ops');
  });

  it('routes avatar.clear through the identity bridge', async () => {
    const calls: BotIdentityPatchPayload[] = [];
    setBotIdentityBridge(async (payload) => {
      calls.push(payload);
      return { success: true, result: {} };
    });

    const result = await updateStateTool.execute(
      { target: 'avatar', action: 'clear' },
      undefined,
      makeContext(),
    );
    expect(JSON.parse(result.result)).toMatchObject({ success: true, subaction: 'avatar.clear' });
    expect(calls[0].subaction).toBe('avatar.clear');
  });

  it('surfaces bridge errors as structured failures', async () => {
    setBotIdentityBridge(async () => ({
      success: false,
      error: { code: 'IDENTITY_MISMATCH', message: 'mismatch' },
    }));
    const result = await updateStateTool.execute(
      { target: 'profile', action: 'set', name: 'x' },
      undefined,
      makeContext(),
    );
    expect(result.error).toBe(true);
    expect(JSON.parse(result.result)).toMatchObject({
      success: false,
      error: { code: 'IDENTITY_MISMATCH' },
    });
  });

  it('returns NO_BRIDGE when no identity bridge is available', async () => {
    const result = await updateStateTool.execute(
      { target: 'profile', action: 'set', name: 'x' },
      undefined,
      makeContext(),
    );
    expect(JSON.parse(result.result)).toMatchObject({
      success: false,
      error: { code: 'NO_BRIDGE' },
    });
  });

  it('returns NO_IDENTITY when no agent profile is bound', async () => {
    const result = await updateStateTool.execute(
      { target: 'profile', action: 'set', name: 'x' },
      undefined,
      makeContext({ agentProfileId: null }),
    );
    expect(JSON.parse(result.result)).toMatchObject({
      success: false,
      error: { code: 'NO_IDENTITY' },
    });
  });
});

describe('UpdateStateTool.checkPermissions — identity subactions', () => {
  it('pre-approves identity writes (self-scoped)', () => {
    const verdict = updateStateTool.checkPermissions(
      { target: 'profile', action: 'set', name: 'x' },
      {} as Parameters<typeof updateStateTool.checkPermissions>[1],
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.requiresUserConfirmation).toBeFalsy();
  });
});
