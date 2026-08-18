import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK,
  BACKGROUND_SUBAGENT_IDLE_NOTICE,
  shouldContinueParentWork,
} from '../continueParentWork.js';

describe('shouldContinueParentWork', () => {
  it('returns false when there are no user asks', () => {
    expect(shouldContinueParentWork([], 'review', 'spawn a reviewer')).toBe(false);
  });

  it('returns false for a pure delegation ask with no parent exec', () => {
    const asks = ['spawn a subagent to review the pull request'];
    expect(shouldContinueParentWork(asks, 'code review', 'review the pr')).toBe(false);
  });

  it('returns true when the latest ask has exec work and is a delegation', () => {
    const asks = ['fix the failing test, then spawn a subagent to review the pr'];
    expect(shouldContinueParentWork(asks, 'review', 'review the pr')).toBe(true);
  });

  it('returns true when the latest ask has exec work and is not a delegation', () => {
    const asks = ['fix all the bugs in the new flow'];
    expect(shouldContinueParentWork(asks, 'review', 'review the pr')).toBe(true);
  });

  it('returns true when a recent prior ask still has exec work', () => {
    const asks = [
      'implement the export feature',
      'spawn a subagent to review the code',
    ];
    expect(shouldContinueParentWork(asks, 'review', 'review the code')).toBe(true);
  });

  it('returns true for "while waiting, spawn …" phrasing', () => {
    const asks = ['while waiting, spawn a subagent to draft the docs'];
    expect(shouldContinueParentWork(asks, 'docs', 'draft docs')).toBe(true);
  });

  it('returns false for empty / blank text', () => {
    expect(shouldContinueParentWork([''], 'x', 'y')).toBe(false);
    expect(shouldContinueParentWork(['   '], 'x', 'y')).toBe(false);
  });
});

describe('guidance constants', () => {
  it('exposes the two complementary prompts', () => {
    expect(BACKGROUND_SUBAGENT_CONTINUE_PARENT_WORK).toContain(
      'Continue unfinished parent work now',
    );
    expect(BACKGROUND_SUBAGENT_IDLE_NOTICE).toContain('yield the turn');
    expect(BACKGROUND_SUBAGENT_IDLE_NOTICE).toContain('completion notification');
  });
});