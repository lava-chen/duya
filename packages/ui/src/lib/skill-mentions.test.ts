import { describe, it, expect } from 'vitest';
import { rewriteSkillMentionTokens } from './skill-mentions';

describe('rewriteSkillMentionTokens (Plan 450 Phase H)', () => {
  const skills = [
    { name: 'commit' },
    { name: 'review', aliases: ['code-review'] },
    { name: 'memory-setup' },
  ];

  it('returns content unchanged when no skills are available', () => {
    const result = rewriteSkillMentionTokens('/commit now', []);
    expect(result.content).toBe('/commit now');
    expect(result.mentionedSkills).toEqual([]);
  });

  it('rewrites a leading /name into a skill:// link', () => {
    const result = rewriteSkillMentionTokens('/commit fix the bug', skills);
    expect(result.content).toBe('[/commit](skill://commit) fix the bug');
    expect(result.mentionedSkills).toEqual(['commit']);
  });

  it('matches case-insensitively and returns the canonical name', () => {
    const result = rewriteSkillMentionTokens('/Commit now', skills);
    expect(result.mentionedSkills).toEqual(['commit']);
    expect(result.content).toBe('[/commit](skill://commit) now');
  });

  it('resolves aliases to the canonical skill name', () => {
    const result = rewriteSkillMentionTokens('/code-review please', skills);
    expect(result.content).toBe('[/review](skill://review) please');
    expect(result.mentionedSkills).toEqual(['review']);
  });

  it('matches line-leading slash commands in multi-line content', () => {
    const result = rewriteSkillMentionTokens('first do setup\n/review the diff', skills);
    expect(result.content).toBe('first do setup\n[/review](skill://review) the diff');
    expect(result.mentionedSkills).toEqual(['review']);
  });

  it('does not match slash tokens mid-line or inside paths', () => {
    const result = rewriteSkillMentionTokens('see /usr/bin/env and run npm /commit', skills);
    expect(result.content).toBe('see /usr/bin/env and run npm /commit');
    expect(result.mentionedSkills).toEqual([]);
  });

  it('leaves unknown slash commands untouched', () => {
    const result = rewriteSkillMentionTokens('/unknowncommand go', skills);
    expect(result.content).toBe('/unknowncommand go');
    expect(result.mentionedSkills).toEqual([]);
  });

  it('accepts a bare /name with no trailing text', () => {
    const result = rewriteSkillMentionTokens('/memory-setup', skills);
    expect(result.content).toBe('[/memory-setup](skill://memory-setup)');
    expect(result.mentionedSkills).toEqual(['memory-setup']);
  });

  it('is idempotent over already-rewritten links', () => {
    const once = rewriteSkillMentionTokens('/commit fix it', skills);
    const twice = rewriteSkillMentionTokens(once.content, skills);
    expect(twice.content).toBe(once.content);
    expect(twice.mentionedSkills).toEqual(['commit']);
  });

  it('collects multiple mentions in first-seen order', () => {
    const result = rewriteSkillMentionTokens('/review\n/commit', skills);
    expect(result.mentionedSkills).toEqual(['review', 'commit']);
  });
});
