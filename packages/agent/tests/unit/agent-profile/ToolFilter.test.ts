/**
 * Tests for ToolFilter — single-pass tool visibility.
 */

import { describe, it, expect } from 'vitest';
import {
  matchToolPattern,
  isToolVisible,
  resolveAllowedTools,
  validateToolAccess,
  type ToolVisibilityConstraints,
} from '../../../src/agent-profile/ToolFilter.js';
import type { AgentProfile } from '../../../src/agent-profile/types.js';
import { PRESET_AGENT_PROFILES } from '../../../src/agent-profile/types.js';

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

const NO_CONSTRAINTS: ToolVisibilityConstraints = {};
const EMPTY_DISCOVERED = new Set<string>();

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

describe('isToolVisible', () => {
  it('always-exposed tool with no constraints is visible', () => {
    expect(isToolVisible('read', 'always', EMPTY_DISCOVERED, NO_CONSTRAINTS)).toBe(true);
  });

  it('internal tool is never visible', () => {
    expect(isToolVisible('debug', 'internal', EMPTY_DISCOVERED, NO_CONSTRAINTS)).toBe(false);
  });

  it('discoverable tool is hidden until discovered', () => {
    expect(isToolVisible('browser', 'discoverable', EMPTY_DISCOVERED, NO_CONSTRAINTS)).toBe(false);
    expect(isToolVisible('browser', 'discoverable', new Set(['browser']), NO_CONSTRAINTS)).toBe(true);
  });

  it('disabledTools (exact) hides the tool', () => {
    expect(isToolVisible('read', 'always', EMPTY_DISCOVERED, { disabledTools: ['read'] })).toBe(false);
    expect(isToolVisible('write', 'always', EMPTY_DISCOVERED, { disabledTools: ['read'] })).toBe(true);
  });

  it('profileDisallowedPatterns (wildcard) hides matching tools', () => {
    const c: ToolVisibilityConstraints = { profileDisallowedPatterns: ['exec:*'] };
    expect(isToolVisible('exec:bash', 'always', EMPTY_DISCOVERED, c)).toBe(false);
    expect(isToolVisible('file:read', 'always', EMPTY_DISCOVERED, c)).toBe(true);
  });

  it('allowedTools (exact) restricts to listed tools', () => {
    const c: ToolVisibilityConstraints = { allowedTools: ['read', 'glob'] };
    expect(isToolVisible('read', 'always', EMPTY_DISCOVERED, c)).toBe(true);
    expect(isToolVisible('write', 'always', EMPTY_DISCOVERED, c)).toBe(false);
  });

  it('profileAllowedPatterns (wildcard) restricts to matching tools', () => {
    const c: ToolVisibilityConstraints = { profileAllowedPatterns: ['file:*', 'search:*'] };
    expect(isToolVisible('file:read', 'always', EMPTY_DISCOVERED, c)).toBe(true);
    expect(isToolVisible('search:grep', 'always', EMPTY_DISCOVERED, c)).toBe(true);
    expect(isToolVisible('exec:bash', 'always', EMPTY_DISCOVERED, c)).toBe(false);
  });

  it('deny wins over allow', () => {
    const c: ToolVisibilityConstraints = {
      profileAllowedPatterns: ['file:*', 'exec:*'],
      profileDisallowedPatterns: ['exec:bash'],
    };
    expect(isToolVisible('file:read', 'always', EMPTY_DISCOVERED, c)).toBe(true);
    expect(isToolVisible('exec:python', 'always', EMPTY_DISCOVERED, c)).toBe(true);
    expect(isToolVisible('exec:bash', 'always', EMPTY_DISCOVERED, c)).toBe(false);
  });

  it('discovered tool still respects denylist', () => {
    const c: ToolVisibilityConstraints = { disabledTools: ['browser'] };
    expect(isToolVisible('browser', 'discoverable', new Set(['browser']), c)).toBe(false);
  });
});

describe('resolveAllowedTools (profile-only)', () => {
  it('should allow all tools by default', () => {
    const profile = makeProfile();
    const result = resolveAllowedTools(profile, ALL_TOOLS);
    expect(result.allowed).toHaveLength(ALL_TOOLS.length);
    expect(result.isValid).toBe(true);
  });

  it('should whitelist with allowedTools', () => {
    const profile = makeProfile({ allowedTools: ['file:*', 'search:*'] });
    const result = resolveAllowedTools(profile, ALL_TOOLS);
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('search:grep');
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('brief');
  });

  it('should blacklist with disallowedTools', () => {
    const profile = makeProfile({ disallowedTools: ['exec:*', 'browser:*'] });
    const result = resolveAllowedTools(profile, ALL_TOOLS);
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).not.toContain('exec:bash');
    expect(result.allowed).not.toContain('browser:navigate');
  });

  it('deny takes precedence over allow', () => {
    const profile = makeProfile({
      allowedTools: ['file:*', 'exec:*'],
      disallowedTools: ['exec:bash'],
    });
    const result = resolveAllowedTools(profile, ALL_TOOLS);
    expect(result.allowed).toContain('file:read');
    expect(result.allowed).toContain('exec:python');
    expect(result.allowed).not.toContain('exec:bash');
  });

  it('gives Gateway shell access while blocking recursive and mode tools', () => {
    const gateway = PRESET_AGENT_PROFILES.find((profile) => profile.id === 'gateway');
    expect(gateway).toBeDefined();

    const registeredGatewaySurface = [
      'bash',
      'powershell',
      'read',
      'glob',
      'grep',
      'MessageSession',
      'SessionSearch',
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
      'SwitchMode',
    ];
    const result = resolveAllowedTools(gateway!, registeredGatewaySurface);

    expect(result.allowed).toEqual(expect.arrayContaining([
      'bash',
      'powershell',
      'read',
      'glob',
      'grep',
      'MessageSession',
      'SessionSearch',
    ]));
    expect(result.allowed).not.toEqual(expect.arrayContaining([
      'Agent',
      'EnterPlanMode',
      'ExitPlanMode',
      'SwitchMode',
    ]));
  });
});

describe('validateToolAccess', () => {
  it('should not throw for valid results', () => {
    const result = resolveAllowedTools(makeProfile(), ALL_TOOLS);
    expect(() => validateToolAccess(result)).not.toThrow();
  });

  it('should throw when no tools are available', () => {
    const result = resolveAllowedTools(
      makeProfile({ disallowedTools: ['*'] }),
      ALL_TOOLS,
    );
    expect(() => validateToolAccess(result)).toThrow('No tools available');
  });
});
