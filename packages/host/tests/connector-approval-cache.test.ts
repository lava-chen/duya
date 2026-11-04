import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginApprovalSession,
  rememberSessionApproval,
  isSessionApproved,
  clearSessionApprovals,
} from '../src/authorization/connector-approval-cache';

describe('AppConnectionTool session approvals (Plan 449)', () => {
  beforeEach(() => clearSessionApprovals());

  it('starts with no approvals', () => {
    expect(isSessionApproved('session-a', 'remote_notion_search')).toBe(false);
  });

  it('remembers an approved tool', () => {
    rememberSessionApproval('session-a', 'remote_notion_search');
    expect(isSessionApproved('session-a', 'remote_notion_search')).toBe(true);
    expect(isSessionApproved('session-a', 'remote_notion_create_page')).toBe(false);
  });

  it('ignores empty tool names and empty session ids', () => {
    rememberSessionApproval('session-a', '');
    rememberSessionApproval('', 'remote_notion_search');
    expect(isSessionApproved('session-a', '')).toBe(false);
    expect(isSessionApproved('', 'remote_notion_search')).toBe(false);
  });

  it('clears all approvals', () => {
    rememberSessionApproval('session-a', 'a');
    rememberSessionApproval('session-a', 'b');
    clearSessionApprovals();
    expect(isSessionApproved('session-a', 'a')).toBe(false);
    expect(isSessionApproved('session-a', 'b')).toBe(false);
  });

  it('clears one session without touching another', () => {
    rememberSessionApproval('session-a', 'remote_notion_search');
    rememberSessionApproval('session-b', 'remote_notion_search');
    clearSessionApprovals('session-a');
    expect(isSessionApproved('session-a', 'remote_notion_search')).toBe(false);
    expect(isSessionApproved('session-b', 'remote_notion_search')).toBe(true);
  });

  // The regression this file exists for: a recycled worker serves more than
  // one session, and a process-wide set of bare tool names let session B ride
  // a grant session A earned.
  it('never lends one session grant to another', () => {
    rememberSessionApproval('session-a', 'remote_notion_search');
    expect(isSessionApproved('session-b', 'remote_notion_search')).toBe(false);
  });

  it('restarts a bucket from the durable rows instead of merging into it', () => {
    rememberSessionApproval('session-a', 'remote_notion_search');
    // `chat:start` replays tool_approval_rules for this session; the durable
    // table is authoritative, so a grant that no longer has a row is gone.
    beginApprovalSession('session-a');
    expect(isSessionApproved('session-a', 'remote_notion_search')).toBe(false);

    rememberSessionApproval('session-a', 'remote_notion_create_page');
    expect(isSessionApproved('session-a', 'remote_notion_create_page')).toBe(true);
  });

  it('leaves other sessions alone when one session restarts', () => {
    rememberSessionApproval('session-a', 'remote_notion_search');
    rememberSessionApproval('session-b', 'remote_notion_search');
    beginApprovalSession('session-a');
    expect(isSessionApproved('session-b', 'remote_notion_search')).toBe(true);
  });
});
