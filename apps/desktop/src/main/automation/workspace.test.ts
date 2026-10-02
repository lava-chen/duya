import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDefaultAutomationWorkspace, resolveAutomationWorkspace } from './workspace';

describe('automation workspace', () => {
  it('defaults to the user-scoped Duya workspace instead of process.cwd()', () => {
    expect(getDefaultAutomationWorkspace()).toBe(join(homedir(), '.duya', 'workspace'));
    expect(resolveAutomationWorkspace('')).toBe(join(homedir(), '.duya', 'workspace'));
  });

  it('expands a user-relative workspace', () => {
    expect(resolveAutomationWorkspace('~/.duya/workspace')).toBe(join(homedir(), '.duya', 'workspace'));
  });
});
