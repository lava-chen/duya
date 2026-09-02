import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetUndeclaredCallStats,
  recordUndeclaredCall,
  readUndeclaredCallStats,
} from '../../src/tool/visibility-guard.js';

describe('visibility guard counters (plan 480 P2.4)', () => {
  beforeEach(() => {
    resetUndeclaredCallStats();
  });

  it('starts empty', () => {
    expect(readUndeclaredCallStats()).toEqual({});
  });

  it('counts undeclared calls per tool name', () => {
    expect(recordUndeclaredCall('mcp_github_create_issue')).toBe(1);
    expect(recordUndeclaredCall('mcp_github_create_issue')).toBe(2);
    recordUndeclaredCall('mcp_slack_post_message');
    expect(readUndeclaredCallStats()).toEqual({
      mcp_github_create_issue: 2,
      mcp_slack_post_message: 1,
    });
  });

  it('resets between test runs', () => {
    recordUndeclaredCall('a');
    resetUndeclaredCallStats();
    expect(readUndeclaredCallStats()).toEqual({});
  });
});
