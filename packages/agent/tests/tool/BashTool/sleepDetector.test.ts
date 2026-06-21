import { describe, expect, it } from 'vitest';
import { detectBlockedSleepPattern } from '../../../src/tool/BashTool/sleepDetector.js';

describe('detectBlockedSleepPattern', () => {
  it('returns null for non-sleep commands', () => {
    expect(detectBlockedSleepPattern('npm test')).toBeNull();
    expect(detectBlockedSleepPattern('echo done')).toBeNull();
  });

  it('returns null for sleep inside pipeline', () => {
    expect(detectBlockedSleepPattern('curl url | sleep 5')).toBeNull();
  });

  it('returns null for sub-2-second sleeps (legitimate pacing)', () => {
    expect(detectBlockedSleepPattern('sleep 0.5')).toBeNull();
    expect(detectBlockedSleepPattern('sleep 1.5')).toBeNull();
  });

  it('returns description for standalone sleep N', () => {
    expect(detectBlockedSleepPattern('sleep 5')).toBe('standalone sleep 5');
    expect(detectBlockedSleepPattern('sleep 30')).toBe('standalone sleep 30');
  });

  it('returns description for sleep N followed by another command', () => {
    expect(detectBlockedSleepPattern('sleep 5 && check')).toBe('sleep 5 followed by: check');
    expect(detectBlockedSleepPattern('sleep 5; check')).toBe('sleep 5 followed by: check');
  });
});
