import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_TYPE,
  describeAgentTypes,
  resolveAgentType,
  unavailableAgentTypeMessage,
} from '../../src/subagents/agent-type-registry.js';

const AGENTS = [
  { agentType: 'general-purpose', whenToUse: 'General agent for multi-step tasks. Use when no specialist fits.' },
  { agentType: 'Explore', whenToUse: 'Fast agent specialized for exploring codebases. Use for quick file and keyword searches.' },
  { agentType: 'Plan', whenToUse: 'Read-only software architect. Designs implementation plans.' },
] as const;

describe('resolveAgentType', () => {
  it('defaults an omitted type to general-purpose', () => {
    const result = resolveAgentType(undefined, AGENTS);
    expect(result).toMatchObject({ ok: true, definition: { agentType: DEFAULT_AGENT_TYPE } });
    expect(resolveAgentType('   ', AGENTS)).toMatchObject({ ok: true, definition: { agentType: 'general-purpose' } });
  });

  it('normalizes aliases and case onto canonical ids', () => {
    expect(resolveAgentType('explore', AGENTS)).toMatchObject({ ok: true, definition: { agentType: 'Explore' } });
    expect(resolveAgentType('explorer', AGENTS)).toMatchObject({ ok: true, definition: { agentType: 'Explore' } });
    expect(resolveAgentType('Explore', AGENTS)).toMatchObject({ ok: true, definition: { agentType: 'Explore' } });
    expect(resolveAgentType('code-review', [{ agentType: 'CodeReview' } as never])).toMatchObject({
      ok: true,
      definition: { agentType: 'CodeReview' },
    });
    expect(resolveAgentType('General-Purpose', AGENTS)).toMatchObject({
      ok: true,
      definition: { agentType: 'general-purpose' },
    });
  });

  it('rejects unknown types with the full available list', () => {
    const result = resolveAgentType('no-such-agent', AGENTS);
    if (result.ok) throw new Error('expected rejection');
    expect(result.requested).toBe('no-such-agent');
    expect(result.available).toEqual(['general-purpose', 'Explore', 'Plan']);
    expect(unavailableAgentTypeMessage(result)).toBe(
      'Agent type "no-such-agent" not found. Available types: general-purpose, Explore, Plan',
    );
  });

  it('rejects when there are no definitions at all', () => {
    const result = resolveAgentType('Explore', []);
    expect(result.ok).toBe(false);
  });
});

describe('describeAgentTypes', () => {
  it('renders one bounded line per definition', () => {
    const text = describeAgentTypes(AGENTS);
    expect(text).toBe(
      [
        '- general-purpose — General agent for multi-step tasks.',
        '- Explore — Fast agent specialized for exploring codebases.',
        '- Plan — Read-only software architect.',
      ].join('\n'),
    );
  });

  it('clamps overlong whenToUse text', () => {
    const text = describeAgentTypes([
      { agentType: 'Chatty', whenToUse: `word `.repeat(80) },
    ]);
    expect(text).toContain('- Chatty — ');
    expect(text.length).toBeLessThan(200);
  });
});
