/**
 * ToolFilter visibility tests (plan 496 exposure promotion).
 *
 * Core regression: SendMessage (and the rest of BOT_TOOLSET) register as
 * `exposeMode: 'discoverable'` and were unreachable for bot profiles — the
 * discovery gate fired before the allowlist check, so an explicitly named
 * allowlist entry never surfaced the tool. Plan 496 adds exact-entry
 * promotion: a non-wildcard allowlist entry is a deliberate exposure
 * decision.
 */

import { describe, expect, it } from 'vitest';
import { isToolVisible, matchToolPattern } from '../ToolFilter.js';

const NO_CONSTRAINTS = {};

function constraints(allow?: string[], deny?: string[]) {
  return {
    profileAllowedPatterns: allow,
    profileDisallowedPatterns: deny,
  };
}

describe('matchToolPattern', () => {
  it('handles exact, wildcard, and prefix patterns', () => {
    expect(matchToolPattern('SendMessage', '*')).toBe(true);
    expect(matchToolPattern('SendMessage', 'SendMessage')).toBe(true);
    expect(matchToolPattern('SendMessage', 'send_message')).toBe(false);
    expect(matchToolPattern('file:read_file', 'file:*')).toBe(true);
    expect(matchToolPattern('Bash', 'file:*')).toBe(false);
  });
});

describe('isToolVisible — plan 496 exact-entry promotion', () => {
  it('hides a discoverable tool that was never discovered and never allowed', () => {
    expect(isToolVisible('SendMessage', 'discoverable', new Set(), NO_CONSTRAINTS)).toBe(false);
  });

  it('shows a discoverable tool once discovered', () => {
    expect(isToolVisible('SendMessage', 'discoverable', new Set(['SendMessage']), NO_CONSTRAINTS)).toBe(true);
  });

  it('promotes a discoverable tool on an exact profile allowlist entry', () => {
    expect(isToolVisible('SendMessage', 'discoverable', new Set(), constraints(['*', 'SendMessage']))).toBe(true);
  });

  it('promotes a discoverable tool on an exact caller allowlist entry', () => {
    expect(
      isToolVisible('SendMessage', 'discoverable', new Set(), {
        allowedTools: ['SendMessage'],
      }),
    ).toBe(true);
  });

  it('a wildcard allowlist alone does NOT promote', () => {
    expect(isToolVisible('SendMessage', 'discoverable', new Set(), constraints(['*']))).toBe(false);
    expect(isToolVisible('SendMessage', 'discoverable', new Set(), constraints(['send*']))).toBe(false);
  });

  it('promote does not override a deny entry', () => {
    expect(isToolVisible('SendMessage', 'discoverable', new Set(), constraints(['SendMessage'], ['SendMessage']))).toBe(false);
  });

  it('promote does not apply to hidden tools', () => {
    expect(isToolVisible('SendMessage', 'hidden', new Set(['SendMessage']), constraints(['SendMessage']))).toBe(false);
  });

  it('hint tools are visible without discovery (stub entry, not full schema)', () => {
    expect(isToolVisible('mcp__srv__query', 'hint', new Set(), NO_CONSTRAINTS)).toBe(true);
  });

  it('hint tools still respect deny/allow constraints', () => {
    expect(isToolVisible('mcp__srv__query', 'hint', new Set(), constraints(['other_tool']))).toBe(false);
    expect(isToolVisible('mcp__srv__query', 'hint', new Set(), constraints(['mcp__srv__query']))).toBe(true);
  });

  it('always-exposed tools keep working regardless of promotion', () => {
    expect(isToolVisible('Bash', 'always', new Set(), NO_CONSTRAINTS)).toBe(true);
  });
});
