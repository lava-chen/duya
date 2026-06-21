import { describe, expect, it } from 'vitest';
import {
  DISALLOWED_AUTO_BACKGROUND_COMMANDS,
  isAutobackgroundingAllowed,
  isBackgroundTasksDisabled,
} from '../../../src/tool/BashTool/autoBackground.js';

describe('isAutobackgroundingAllowed', () => {
  it('allows most commands', () => {
    expect(isAutobackgroundingAllowed('npm run dev')).toBe(true);
    expect(isAutobackgroundingAllowed('python train.py')).toBe(true);
    expect(isAutobackgroundingAllowed('curl `https://example.com`')).toBe(true);
    expect(isAutobackgroundingAllowed('echo hello')).toBe(true);
  });

  it('rejects bare sleep to keep it in foreground', () => {
    expect(isAutobackgroundingAllowed('sleep 5')).toBe(false);
    expect(isAutobackgroundingAllowed('sleep 60')).toBe(false);
    expect(isAutobackgroundingAllowed('sleep 0.5')).toBe(false);
  });

  it('allows sleep inside a pipeline or subshell', () => {
    expect(isAutobackgroundingAllowed('foo | sleep 5')).toBe(true);
    expect(isAutobackgroundingAllowed('(sleep 5; echo done)')).toBe(true);
  });

  it('returns true for empty command', () => {
    expect(isAutobackgroundingAllowed('')).toBe(true);
  });
});

describe('DISALLOWED_AUTO_BACKGROUND_COMMANDS', () => {
  it('only blocks sleep', () => {
    expect(DISALLOWED_AUTO_BACKGROUND_COMMANDS).toEqual(['sleep']);
  });
});

describe('isBackgroundTasksDisabled', () => {
  it('returns true when DUYA_DISABLE_BACKGROUND_TASKS is truthy', () => {
    expect(isBackgroundTasksDisabled({ DUYA_DISABLE_BACKGROUND_TASKS: '1' })).toBe(true);
    expect(isBackgroundTasksDisabled({ DUYA_DISABLE_BACKGROUND_TASKS: 'true' })).toBe(true);
  });

  it('returns false when env unset', () => {
    expect(isBackgroundTasksDisabled({})).toBe(false);
  });
});
