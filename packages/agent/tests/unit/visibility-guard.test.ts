import { describe, expect, it, beforeEach } from 'vitest';
import {
  evaluateVisibilityGuard,
  VISIBILITY_DENIAL_MESSAGE,
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

  it('allows declared calls and points deferred calls to the unified catalog path', () => {
    expect(evaluateVisibilityGuard({ declaredTools: new Set(['tool_catalog']), toolName: 'tool_catalog' }))
      .toEqual({ undeclared: false });
    expect(evaluateVisibilityGuard({ declaredTools: new Set(['tool_catalog']), toolName: 'deferred_tool' }))
      .toEqual({ undeclared: true, message: VISIBILITY_DENIAL_MESSAGE('deferred_tool') });
    expect(VISIBILITY_DENIAL_MESSAGE('deferred_tool')).toContain('tool_catalog');
    expect(VISIBILITY_DENIAL_MESSAGE('deferred_tool')).toContain('tool_invoke');
  });
});
