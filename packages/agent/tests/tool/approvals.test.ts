import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberSessionApproval,
  isSessionApproved,
  clearSessionApprovals,
} from '../../src/tool/AppConnectionTool/approvals';

describe('AppConnectionTool session approvals (Plan 449)', () => {
  beforeEach(() => clearSessionApprovals());

  it('starts with no approvals', () => {
    expect(isSessionApproved('remote_notion_search')).toBe(false);
  });

  it('remembers an approved tool', () => {
    rememberSessionApproval('remote_notion_search');
    expect(isSessionApproved('remote_notion_search')).toBe(true);
    expect(isSessionApproved('remote_notion_create_page')).toBe(false);
  });

  it('ignores empty tool names', () => {
    rememberSessionApproval('');
    expect(isSessionApproved('')).toBe(false);
  });

  it('clears all approvals', () => {
    rememberSessionApproval('a');
    rememberSessionApproval('b');
    clearSessionApprovals();
    expect(isSessionApproved('a')).toBe(false);
    expect(isSessionApproved('b')).toBe(false);
  });
});
