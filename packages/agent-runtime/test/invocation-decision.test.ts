import { describe, expect, it, vi } from 'vitest';
import { memoizeInvocationDecision } from '../src/authorization/invocation-decision.js';

describe('invocation decisions', () => {
  it('consumes a one-shot grant once across concurrent dispatch and execution checks', async () => {
    let grantAvailable = true;
    const evaluate = vi.fn(async () => {
      const allowed = grantAvailable;
      grantAvailable = false;
      return { allowed };
    });
    const authorize = memoizeInvocationDecision(evaluate);
    const dispatch = authorize('write', { path: 'a', content: 'b' }, 'call-1');
    const execution = authorize('write', { content: 'b', path: 'a' }, 'call-1');
    expect(dispatch).toBe(execution);
    expect(await dispatch).toEqual({ allowed: true });
    expect(await execution).toEqual({ allowed: true });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(await authorize('write', { path: 'a', content: 'b' }, 'call-2')).toEqual({ allowed: false });
  });

  it('refuses a changed operation under an already-decided invocation identity', async () => {
    const evaluate = vi.fn(async () => 'allow');
    const authorize = memoizeInvocationDecision(evaluate);
    await authorize('read', { path: 'a' }, 'call-1');
    await expect(authorize('read', { path: 'b' }, 'call-1')).rejects.toThrow('different arguments');
    await expect(authorize('write', { path: 'a' }, 'call-1')).rejects.toThrow('different arguments');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('evaluates the checked arguments when the caller mutates its object before dispatch', async () => {
    const evaluate = vi.fn(async (_name: string, input?: Record<string, unknown>) => input?.path);
    const authorize = memoizeInvocationDecision(evaluate);
    const input = { path: 'approved-file' };
    const decision = authorize('write', input, 'call-1');
    input.path = 'another-file';
    expect(await decision).toBe('approved-file');
    await expect(authorize('write', input, 'call-1')).rejects.toThrow('different arguments');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('keeps unanchored checks and separate turn readers independent', async () => {
    const evaluate = vi.fn(async () => false);
    const firstTurn = memoizeInvocationDecision(evaluate);
    const secondTurn = memoizeInvocationDecision(evaluate);
    await firstTurn('read', {});
    await firstTurn('read', {});
    await firstTurn('read', {}, 'call-1');
    await secondTurn('read', {}, 'call-1');
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it('retains evaluator failures instead of silently consuming a second grant', async () => {
    const evaluate = vi.fn(async () => { throw new Error('approval store unavailable'); });
    const authorize = memoizeInvocationDecision(evaluate);
    await expect(authorize('read', {}, 'call-1')).rejects.toThrow('store unavailable');
    await expect(authorize('read', {}, 'call-1')).rejects.toThrow('store unavailable');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('refuses arguments that cannot identify a JSON tool operation', async () => {
    const evaluate = vi.fn(async () => true);
    const authorize = memoizeInvocationDecision(evaluate);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(authorize('read', cyclic, 'call-1')).rejects.toThrow('JSON values');
    await expect(authorize('read', { number: Infinity }, 'call-2')).rejects.toThrow('JSON values');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
