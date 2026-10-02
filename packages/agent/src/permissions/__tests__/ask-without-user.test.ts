// Plan 583 / ISS-11: the shared `ask`-without-a-user resolution.
import { describe, it, expect } from 'vitest';
import { resolveAskWithoutUser } from '../askWithoutUser.js';
import type { PermissionMode } from '../types.js';

const ASKING_MODES: PermissionMode[] = ['default', 'auto', 'acceptEdits', 'plan', 'bubble'];
const NEVER_ASKING_MODES: PermissionMode[] = ['dontAsk', 'bypassPermissions'];

describe('resolveAskWithoutUser', () => {
  it('denies in every mode that means the user wants to be asked', () => {
    for (const mode of ASKING_MODES) {
      expect(resolveAskWithoutUser(mode, 'some_tool').behavior, mode).toBe('deny');
    }
  });

  it('allows only in the two modes that declare nobody will be asked', () => {
    for (const mode of NEVER_ASKING_MODES) {
      const outcome = resolveAskWithoutUser(mode, 'some_tool');
      expect(outcome.behavior, mode).toBe('allow');
      expect(outcome.message).toContain(mode);
    }
  });

  it('denies on an undefined mode so an unwired hook fails closed', () => {
    const outcome = resolveAskWithoutUser(undefined, 'some_tool');
    expect(outcome.behavior).toBe('deny');
    expect(outcome.message).toContain('some_tool');
  });

  it('denies on a mode it does not recognise', () => {
    // A mode drifting ahead of the union must not be read as consent.
    expect(resolveAskWithoutUser('someFutureMode' as PermissionMode, 'some_tool').behavior).toBe('deny');
  });

  it('names the tool in the deny message and the mode when known', () => {
    expect(resolveAskWithoutUser('default', 'mcp__evil__run').message).toContain('mcp__evil__run');
    expect(resolveAskWithoutUser('default', 'mcp__evil__run').message).toContain('`default`');
    expect(resolveAskWithoutUser(undefined, 'mcp__evil__run').message).not.toContain('permission mode');
  });

  it('tells the operator how to get unattended execution on purpose', () => {
    const message = resolveAskWithoutUser('default', 'some_tool').message;
    expect(message).toContain('dontAsk');
    expect(message).toContain('bypassPermissions');
  });
});
