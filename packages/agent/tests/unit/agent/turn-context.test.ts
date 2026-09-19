/**
 * TurnContext unit tests — Plan 550 step 2a.
 *
 * The class is unused at runtime in this commit (the assembler
 * wires it in 2a-2e), so the tests pin the data contract only:
 *  - shape fields survive a round-trip,
 *  - the instance is frozen so downstream code cannot mutate it,
 *  - NO_MENTIONS / NO_APPROVAL_LEDGER are stable references.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
  TurnContext,
  type TurnContextShape,
  type TurnId,
} from '../../../src/agent/TurnContext.js';

function baseShape(overrides: Partial<TurnContextShape> = {}): TurnContextShape {
  const turnId: TurnId = { sequence: 1, id: 'turn-1' };
  return {
    turnId,
    sessionId: 'session-1',
    workingDirectory: 'E:\\Projects\\duya',
    permissionMode: 'default',
    additionalWorkingDirectories: new Map(),
    approval: NO_APPROVAL_LEDGER,
    mentions: NO_MENTIONS,
    promptText: 'hello',
    ...overrides,
  };
}

describe('TurnContext', () => {
  it('round-trips every shape field', () => {
    const ctx = new TurnContext(
      baseShape({
        language: 'zh-CN',
        communicationPlatform: 'cli',
        promptText: 'multi\nline\nprompt',
      }),
    );
    expect(ctx.turnId).toEqual({ sequence: 1, id: 'turn-1' });
    expect(ctx.sessionId).toBe('session-1');
    expect(ctx.workingDirectory).toBe('E:\\Projects\\duya');
    expect(ctx.language).toBe('zh-CN');
    expect(ctx.communicationPlatform).toBe('cli');
    expect(ctx.permissionMode).toBe('default');
    expect(ctx.promptText).toBe('multi\nline\nprompt');
  });

  it('freezes the instance so downstream code cannot mutate it', () => {
    const ctx = new TurnContext(baseShape());
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      // @ts-expect-error -- intentional runtime mutation attempt
      ctx.promptText = 'tampered';
    }).toThrow();
  });

  it('accepts an absent turnId without crashing', () => {
    const ctx = new TurnContext(baseShape({ turnId: null }));
    expect(ctx.turnId).toBeNull();
  });

  it('preserves optional communicationPlatform / language as undefined', () => {
    const ctx = new TurnContext(baseShape());
    expect(ctx.communicationPlatform).toBeUndefined();
    expect(ctx.language).toBeUndefined();
  });
});

describe('NO_MENTIONS', () => {
  it('is a frozen singleton with empty arrays', () => {
    expect(NO_MENTIONS.skills).toEqual([]);
    expect(NO_MENTIONS.plugins).toEqual([]);
    expect(NO_MENTIONS.contexts).toEqual([]);
    expect(Object.isFrozen(NO_MENTIONS)).toBe(true);
  });
});

describe('NO_APPROVAL_LEDGER', () => {
  it('is a frozen singleton with an empty always-allow set', () => {
    expect(NO_APPROVAL_LEDGER.alwaysAllowTools.size).toBe(0);
    expect(NO_APPROVAL_LEDGER.consumeApprovedEffect).toBeUndefined();
    expect(Object.isFrozen(NO_APPROVAL_LEDGER)).toBe(true);
  });
});