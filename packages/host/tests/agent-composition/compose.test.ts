/**
 * Plan 624 v2 G1 — the frozen per-run composition plan.
 *
 * These tests pin the properties that make the control layer a single policy
 * point: purity, immutability, complete provenance, and the separation of
 * caller injections from the decisions that describe them.
 */
import { describe, expect, it } from 'vitest';

import {
  composeAgent,
  composeStartup,
  readTurnOverrides,
} from '@duya/host/agent-composition';
import { MAIN_AGENT_PROFILES } from '@duya/host/worker-profiles';
import type { AgentProfile } from '@duya/agent-core';

const codeExpert = MAIN_AGENT_PROFILES.find((profile) => profile.id === 'code-expert') as AgentProfile;

const baseInput = {
  profile: codeExpert,
  cache: { protocol: 'openai' as const, api: 'responses' as const, sessionId: 'session-624' },
  permissions: { permissionMode: 'acceptEdits' },
  modeLookup: { get: () => undefined },
  environment: { sessionId: 'session-624', workingDirectory: 'E:/Projects/duya' },
};

describe('plan 624 v2 — composeAgent', () => {
  it('produces all seven dimensions in one call', () => {
    const plan = composeAgent(baseInput);

    expect(plan.scope).toBe('main-session');
    expect(plan.prompt.promptSystem).toBe('code');
    expect(plan.tools.profileAllowedPatterns).toEqual(['*']);
    expect(plan.modes.activeModeIds).toEqual([]);
    expect(plan.permissions.permissionMode).toBe('acceptEdits');
    expect(plan.cache.family).toBe('openai-responses');
    expect(plan.cache.promptCacheKey).toBe('session-624');
  });

  it('is frozen at every level a consumer could mutate', () => {
    const plan = composeAgent({ ...baseInput, overrides: readTurnOverrides({ allowedTools: [] }) });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.prompt)).toBe(true);
    expect(Object.isFrozen(plan.tools)).toBe(true);
    expect(Object.isFrozen(plan.modes)).toBe(true);
    expect(Object.isFrozen(plan.permissions)).toBe(true);
    expect(Object.isFrozen(plan.cache)).toBe(true);
    expect(Object.isFrozen(plan.overrides)).toBe(true);
    expect(Object.isFrozen(plan.decisions)).toBe(true);
    expect(Object.isFrozen(plan.decisions[0])).toBe(true);
    expect(Object.isFrozen(plan.tools.turnAllowedTools)).toBe(true);

    expect(() => {
      (plan as unknown as { scope: string }).scope = 'bot';
    }).toThrow(TypeError);
    expect(() => {
      (plan.tools.turnAllowedTools as string[]).push('bash');
    }).toThrow(TypeError);
  });

  it('is deterministic for identical inputs', () => {
    const first = composeAgent(baseInput);
    const second = composeAgent({ ...baseInput, environment: { ...baseInput.environment } });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toHaveLength(16);
  });

  it('excludes the live clock from the fingerprint', () => {
    const reminder = (nowMs: number) => ({
      nowMs,
      windowId: '0',
      turnKind: 'user' as const,
      state: {},
    });
    const early = composeAgent({ ...baseInput, reminder: reminder(1_700_000_000_000) });
    const late = composeAgent({ ...baseInput, reminder: reminder(1_700_000_600_000) });

    expect(early.fingerprint).toBe(late.fingerprint);
    expect(early.reminders?.block).toBeDefined();
    expect(Object.isFrozen(early.reminders?.state ?? {})).toBe(true);
  });

  it('records provenance for every dimension without copying prompt bodies', () => {
    const secret = 'DO-NOT-LOG-THIS-SYSTEM-PROMPT';
    const plan = composeAgent({
      ...baseInput,
      overrides: readTurnOverrides({
        systemPrompt: secret,
        systemPromptPrefix: 'DO-NOT-LOG-THIS-PREFIX',
        allowedTools: ['Read'],
        mode: 'plan',
      }),
    });

    const fields = plan.decisions.map((entry) => entry.field);
    for (const prefix of ['scope', 'prompt.', 'tools.', 'modes.', 'permissions.', 'cache.', 'composition.']) {
      expect(fields.some((field) => field.startsWith(prefix))).toBe(true);
    }
    expect(JSON.stringify(plan.decisions)).not.toContain(secret);
    expect(JSON.stringify(plan.decisions)).not.toContain('DO-NOT-LOG-THIS-PREFIX');
    const injected = plan.decisions.find((entry) => entry.field === 'composition.overrides');
    expect(injected?.value).toBe('systemPrompt,systemPromptPrefix');
  });

  it('keeps a run that must not consume reminder state free of one', () => {
    const plan = composeAgent({ ...baseInput, reminder: null });
    expect(plan.reminders).toBeUndefined();
  });

  it('uses a host-default scope when no profile is applied', () => {
    const plan = composeAgent();
    expect(plan.scope).toBe('main-session');
    expect(plan.decisions[0]).toMatchObject({ field: 'scope', source: 'host-default' });
    expect(plan.prompt.promptSystem).toBe('general');
    expect(plan.cache.family).toBe('none');
  });
});

describe('plan 624 v2 — readTurnOverrides', () => {
  it('is the only reader that normalises disableSystemPrompt', () => {
    expect(readTurnOverrides(undefined).disableSystemPrompt).toBe(false);
    expect(readTurnOverrides({}).disableSystemPrompt).toBe(false);
    expect(readTurnOverrides({ disableSystemPrompt: true }).disableSystemPrompt).toBe(true);
  });

  it('copies every injection field and freezes the result', () => {
    const options = {
      systemPrompt: 'a',
      systemPromptPrefix: 'b',
      disableSystemPrompt: false,
      outputStyleConfig: { name: 'x', prompt: 'y' },
      researchProjectId: 'r1',
      mode: 'plan',
      allowedTools: ['Read'],
      disabledTools: ['Bash'],
    };
    const overrides = readTurnOverrides(options);

    expect(overrides).toMatchObject(options);
    expect(Object.isFrozen(overrides)).toBe(true);
    // Caller-owned structured objects must NOT be frozen by the composition
    // layer — freezing them would mutate an object the session still owns.
    expect(Object.isFrozen(options.outputStyleConfig)).toBe(false);
  });
});

describe('plan 624 v2 — composeStartup', () => {
  it('decides cache family and initial permission mode together', () => {
    const startup = composeStartup({
      cache: { protocol: 'anthropic', sessionId: 's' },
      permissionMode: '',
    });

    expect(startup.cache.family).toBe('anthropic-messages');
    expect(startup.permissions.permissionMode).toBe('default');
    expect(Object.isFrozen(startup)).toBe(true);
    expect(Object.isFrozen(startup.cache)).toBe(true);
    expect(startup.fingerprint).toHaveLength(16);
  });
});
