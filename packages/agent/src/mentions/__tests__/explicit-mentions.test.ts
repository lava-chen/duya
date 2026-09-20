/**
 * explicit-mentions.test.ts
 *
 * Plan 535 Phase B — handwritten `$name` and `skill://name` skill
 * references (codex `collect_explicit_skill_mentions` parity):
 *  - `$name` extraction with the price guards ($5/$20, foo$bar, $$name)
 *  - case-insensitive resolution through the registry (aliases included)
 *  - skill:// targets, both renderer-rewritten markdown links and bare URIs
 *  - unresolvable tokens drop out silently (fail-open text, fail-closed
 *    injection stays with collectSkillInjections)
 *  - mergeSkillMentionSources: popover-first, case-insensitive dedupe
 *  - end-to-end: a $-mentioned hidden skill produces no injection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSkillRegistry, resetSkillRegistry } from '../../skills/registry.js';
import type { PromptSkill } from '../../skills/types.js';
import {
  extractExplicitSkillMentions,
  mergeSkillMentionSources,
  collectSkillInjections,
} from '../index.js';

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'pdf',
    description: 'Create and inspect PDF documents.',
    source: 'bundled',
    skillRoot: '/tmp/skills/pdf',
    getPromptForCommand: async () => 'instructions',
    ...overrides,
  };
}

describe('extractExplicitSkillMentions ($name syntax)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('extracts a single $name reference', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('please run $pdf on this file')).toEqual(['pdf']);
  });

  it('extracts multiple references in resolution order', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    getSkillRegistry().register(makeSkill({ name: 'xlsx' }));
    const mentions = extractExplicitSkillMentions('use $xlsx and $pdf together');
    expect(mentions).toContain('pdf');
    expect(mentions).toContain('xlsx');
    expect(mentions).toHaveLength(2);
  });

  it('resolves case-insensitively', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('use $PDF now')).toEqual(['pdf']);
    expect(extractExplicitSkillMentions('use $Pdf now')).toEqual(['pdf']);
  });

  it('resolves aliases', () => {
    getSkillRegistry().register(makeSkill({ name: 'review', aliases: ['code-review'] }));
    expect(extractExplicitSkillMentions('do a $code-review pass')).toEqual(['review']);
  });

  it('ignores $5/$20-style prices and pure-numeric tokens', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('it costs $20 and $5 more')).toEqual([]);
  });

  it('ignores tokens glued to word characters or double dollars', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('var is foo$pdf and $$pdf here')).toEqual([]);
  });

  it('drops unknown names silently', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('invoke $nonexistent')).toEqual([]);
  });

  it('deduplicates case variants to one canonical name', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const mentions = extractExplicitSkillMentions('$pdf and $PDF and $Pdf');
    expect(mentions).toEqual(['pdf']);
  });

  it('returns nothing for empty or blank prompts', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(extractExplicitSkillMentions('')).toEqual([]);
    expect(extractExplicitSkillMentions('   ')).toEqual([]);
  });
});

describe('extractExplicitSkillMentions (skill:// targets)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('extracts renderer-rewritten markdown links', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const mentions = extractExplicitSkillMentions('see [/pdf](skill://pdf) for details');
    expect(mentions).toEqual(['pdf']);
  });

  it('extracts bare skill:// URIs', () => {
    getSkillRegistry().register(makeSkill({ name: 'xlsx' }));
    expect(extractExplicitSkillMentions('load skill://xlsx directly')).toEqual(['xlsx']);
  });

  it('does not double-report the same skill from link + dollar forms', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const mentions = extractExplicitSkillMentions('[/pdf](skill://pdf) and $pdf too');
    expect(mentions).toEqual(['pdf']);
  });
});

describe('mergeSkillMentionSources', () => {
  it('keeps popover names first and dedupes case-insensitively', () => {
    const merged = mergeSkillMentionSources(['PDF', 'xlsx'], ['pdf', 'review']);
    expect(merged).toEqual(['PDF', 'xlsx', 'review']);
  });

  it('drops blank entries', () => {
    expect(mergeSkillMentionSources(['', '  '], ['pdf'])).toEqual(['pdf']);
  });

  it('returns empty for no sources', () => {
    expect(mergeSkillMentionSources([], [])).toEqual([]);
  });
});

describe('end-to-end: explicit mention of a hidden skill', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('produces no injection for a $-mentioned hidden skill', async () => {
    getSkillRegistry().register(makeSkill({ name: 'secret', isHidden: true }));
    // Extractor resolves the token; the fail-closed injection layer drops it.
    const mentions = extractExplicitSkillMentions('run $secret');
    expect(mentions).toEqual(['secret']);
    expect(await collectSkillInjections(mentions)).toEqual([]);
  });
});
