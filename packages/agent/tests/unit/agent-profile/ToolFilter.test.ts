/**
 * Tests for ToolFilter
 */

import { describe, it, expect } from 'vitest';
import {
  filterTools,
  resolveAllowedTools,
  validateToolAccess,
  matchToolPattern,
  expandToolGroups,
} from '../../../src/agent-profile/ToolFilter.js';
import type { AgentProfile } from '../../../src/agent-profile/types.js';

const ALL_TOOLS = [
  'file:read',
  'file:write',
  'file:edit',
  'search:grep',
  'search:semantic',
  'exec:bash',
  'exec:python',
  'browser:navigate',
  'browser:click',
  'gateway:http',
  'brief',
  'sessions:create',
  'sessions:list',
];

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test',
    name: 'Test',
    isPreset: false,
    isEnabled: true,
    userVisible: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('matchToolPattern', () => {
  it('should match exact tool names', () => {
    expect(matchToolPattern('file:read', 'file:read')).toBe(true);
    expect(matchToolPattern('file:read', 'file:write')).toBe(false);
  });

  it('should match wildcard *', () => {
    expect(matchToolPattern('file:read', '*')).toBe(true);
    expect(matchToolPattern('anything', '*')).toBe(true);
  });

  it('should match group:* patterns', () => {
    expect(matchToolPattern('file:read', 'file:*')).toBe(true);
    expect(matchToolPattern('file:write', 'file:*')).toBe(true);
    expect(matchToolPattern('search:grep', 'file:*')).toBe(false);
  });

  it('should match prefix patterns with *', () => {
    expect(matchToolPattern('file:readText', 'file:read*')).toBe(true);
    expect(matchToolPattern('file:write', 'file:read*')).toBe(false);
  });
});

describe('expandToolGroups', () => {
  it('should expand exact patterns', () => {
    const result = expandToolGroups(['file:read', 'brief'], ALL_TOOLS);
    expect(result).toContain('file:read');
    expect(result).toContain('brief');
    expect(result).not.toContain('file:write');
  });

  it('should expand group:* patterns', () => {
    const result = expandToolGroups(['file:*'], ALL_TOOLS);
    expect(result).toContain('file:read');
    expect(result).toContain('file:write');
    expect(result).toContain('file:edit');
    expect(result).not.toContain('search:grep');
  });

  it('should expand * to all tools', () => {
    const result = expandToolGroups(['*'], ALL_TOOLS);
    expect(result).toHaveLength(ALL_TOOLS.length);
  });
});

describe('filterTools', () => {
  it('should allow all tools by default', () => {
    const profile = makeProfile();
    const result = filterTools({ agentProfile: profile, allTools: ALL_TOOLS });
    expect(result.allowed).toHaveLength(ALL_TOOLS.length);
    expect(result.isValid).toBe(true);
  });

  it('should deny globally disallowed tools', () => {
    const profile = makeProfile();
    const result = filterTools({
      agentProfile: profile,
      allTools: ALL_TOOLS,
      globalDisallowedTools: ['exec:*'],
    });
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('exec:python');
    expect(result.allowed).toContain('file:read');
    expect(result.denialReasons.get('exec:bash')).toBe('globally_denied');
  });

  it('should whitelist with allowedTools', () => {
    const profile = makeProfile({ allowedTools: ['file:*', 'search:*'] });
    const result = filterTools({ agentProfile: profile, allTools: ALL_TOOLS });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('search:grep');
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('brief');
  });

  it('should blacklist with disallowedTools', () => {
    const profile = makeProfile({ disallowedTools: ['exec:*', 'browser:*'] });
    const result = filterTools({ agentProfile: profile, allTools: ALL_TOOLS });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('browser:navigate');
  });

  it('should deny takes precedence over allow', () => {
    const profile = makeProfile({
      allowedTools: ['file:*', 'exec:*'],
      disallowedTools: ['exec:bash'],
    });
    const result = filterTools({ agentProfile: profile, allTools: ALL_TOOLS });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('exec:python');
    expect(result.allowed).not.toContain('exec:bash');
  });

  it('should apply sandbox policy', () => {
    const profile = makeProfile();
    const result = filterTools({
      agentProfile: profile,
      allTools: ALL_TOOLS,
      sandboxPolicy: { deny: ['file:write', 'file:edit'] },
    });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).not.toContain('file:write');
    expect(result.allowed).not.toContain('file:edit');
  });

  it('should apply subagent policy', () => {
    const profile = makeProfile();
    const result = filterTools({
      agentProfile: profile,
      allTools: ALL_TOOLS,
      subagentPolicy: { allow: ['file:read', 'search:*'] },
    });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('search:grep');
    expect(result.allowed).not.toContain('exec:bash');
  });

  it('should handle layered filtering', () => {
    const profile = makeProfile({
      allowedTools: ['file:*', 'search:*', 'exec:*'],
      disallowedTools: ['exec:bash'],
    });
    const result = filterTools({
      agentProfile: profile,
      allTools: ALL_TOOLS,
      globalDisallowedTools: ['file:edit'],
      sandboxPolicy: { deny: ['search:semantic'] },
    });
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('file:write');
    expect(result.allowed).not.toContain('file:edit');
    expect(result.allowed).toContain('search:grep');
    expect(result.allowed).not.toContain('search:semantic');
    expect(result.allowed).toContain('exec:python');
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('browser:navigate');
  });
});

describe('validateToolAccess', () => {
  it('should not throw for valid results', () => {
    const result = filterTools({
      agentProfile: makeProfile(),
      allTools: ALL_TOOLS,
    });
    expect(() => validateToolAccess(result)).not.toThrow();
  });

  it('should throw when no tools are available', () => {
    const result = filterTools({
      agentProfile: makeProfile({ disallowedTools: ['*'] }),
      allTools: ALL_TOOLS,
    });
    expect(() => validateToolAccess(result)).toThrow('No tools available');
  });
});

describe('resolveAllowedTools', () => {
  it('should apply agent profile filtering', () => {
    const profile = makeProfile({
      allowedTools: ['file:read', 'search:*', 'brief'],
    });
    const result = resolveAllowedTools(profile, ALL_TOOLS);
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('search:grep');
    expect(result.allowed).toContain('brief');
    expect(result.allowed).not.toContain('file:write');
    expect(result.allowed).not.toContain('exec:bash');
  });

  it('should apply agent profile with global denials', () => {
    const profile = makeProfile({
      allowedTools: ['file:*', 'search:*', 'exec:*'],
    });
    const result = resolveAllowedTools(profile, ALL_TOOLS, ['browser:*', 'gateway:*']);
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('file:write');
    expect(result.allowed).not.toContain('browser:navigate');
    expect(result.allowed).not.toContain('gateway:http');
  });
});
