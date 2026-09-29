/**
 * ToolFilter visibility tests (plan 496 exposure promotion).
 *
 * Core regression: SendMessage (and the rest of BOT_TOOLSET) register as
 * `exposure: 'deferred'` and were unreachable for bot profiles — the
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
  it('hides a deferred tool that was never promoted or allowlisted', () => {
    expect(isToolVisible('SendMessage', 'deferred', new Set(), NO_CONSTRAINTS)).toBe(false);
  });

  it('shows a deferred tool after an explicit direct-call promotion', () => {
    expect(isToolVisible('SendMessage', 'deferred', new Set(['SendMessage']), NO_CONSTRAINTS)).toBe(true);
  });

  it('promotes a deferred tool on an exact profile allowlist entry', () => {
    expect(isToolVisible('SendMessage', 'deferred', new Set(), constraints(['*', 'SendMessage']))).toBe(true);
  });

  it('promotes a deferred tool on an exact caller allowlist entry', () => {
    expect(
      isToolVisible('SendMessage', 'deferred', new Set(), {
        allowedTools: ['SendMessage'],
      }),
    ).toBe(true);
  });

  it('a wildcard allowlist alone does NOT add deferred tools to the direct tool list', () => {
    expect(isToolVisible('SendMessage', 'deferred', new Set(), constraints(['*']))).toBe(false);
    expect(isToolVisible('SendMessage', 'deferred', new Set(), constraints(['send*']))).toBe(false);
  });

  it('promote does not override a deny entry', () => {
    expect(isToolVisible('SendMessage', 'deferred', new Set(), constraints(['SendMessage'], ['SendMessage']))).toBe(false);
  });

  it('promote does not apply to hidden tools', () => {
    expect(isToolVisible('SendMessage', 'hidden', new Set(['SendMessage']), constraints(['SendMessage']))).toBe(false);
  });

  it('eager tools are visible without catalog selection', () => {
    expect(isToolVisible('mcp__srv__query', 'eager', new Set(), NO_CONSTRAINTS)).toBe(true);
  });

  it('eager tools still respect deny/allow constraints', () => {
    expect(isToolVisible('mcp__srv__query', 'eager', new Set(), constraints(['other_tool']))).toBe(false);
    expect(isToolVisible('mcp__srv__query', 'eager', new Set(), constraints(['mcp__srv__query']))).toBe(true);
  });

  it('eager tools keep working regardless of promotion', () => {
    expect(isToolVisible('Bash', 'eager', new Set(), NO_CONSTRAINTS)).toBe(true);
  });
});
