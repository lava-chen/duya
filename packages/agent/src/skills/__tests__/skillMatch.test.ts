/**
 * skillMatch.test.ts
 *
 * Per-turn skill matching (plan 535 A-4, mcode `matcher(ctx, snapshot)`
 * parity):
 *  - path-like token extraction
 *  - conditional skill activation via prompt path tokens (reason 'path')
 *  - whole-word, case-insensitive name matching (reason 'name')
 *  - fail-closed: hidden / model-invocation-disabled skills never match
 *  - exclusion of already-injected skills + suggestion cap
 *  - the suggestion envelope is null when nothing matched
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  matchSkillsForPrompt,
  buildSkillSuggestionInjection,
  extractPathLikeTokens,
} from '../skillMatch.js';
import { getSkillRegistry, resetSkillRegistry } from '../registry.js';
import { clearConditionalSkills, registerConditionalSkill } from '../conditionalSkills.js';
import type { PromptSkill } from '../types.js';

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'pdf',
    description: 'Create and inspect PDF documents.',
    source: 'bundled',
    skillRoot: '/skills/pdf',
    getPromptForCommand: async () => 'instructions',
    ...overrides,
  };
}

describe('extractPathLikeTokens', () => {
  it('extracts tokens with path separators or file extensions', () => {
    const tokens = extractPathLikeTokens(
      'Please fix src/app.ts and check the docs/readme.md file, then run tests.',
    );
    expect(tokens).toContain('src/app.ts');
    expect(tokens).toContain('docs/readme.md');
    expect(tokens).not.toContain('tests.');
  });

  it('strips surrounding quotes and punctuation', () => {
    const tokens = extractPathLikeTokens('look at "docs/readme.md", and (notes.txt).');
    expect(tokens).toContain('docs/readme.md');
    expect(tokens).toContain('notes.txt');
  });

  it('excludes bare filenames without separators or extensions (strict path shape)', () => {
    // `Dockerfile` is not path-shaped; bare-filename glob matching goes
    // through the cleaned-token superset inside matchSkillsForPrompt.
    const tokens = extractPathLikeTokens('build the Dockerfile for me');
    expect(tokens).not.toContain('Dockerfile');
  });

  it('returns nothing for plain prose', () => {
    expect(extractPathLikeTokens('hello world how are you')).toEqual([]);
  });
});

describe('matchSkillsForPrompt', () => {
  beforeEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
  });

  afterEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
  });

  it('matches a whole-word skill name case-insensitively', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const hits = matchSkillsForPrompt('Can you use the PDF skill to convert this?');
    expect(hits).toHaveLength(1);
    expect(hits[0].skill.name).toBe('pdf');
    expect(hits[0].reason).toBe('name');
  });

  it('does not match partial words or very short names', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(matchSkillsForPrompt('please pdfx this file')).toHaveLength(0);

    getSkillRegistry().register(makeSkill({ name: 'go' }));
    expect(matchSkillsForPrompt('let me go home')).toHaveLength(0);
  });

  it('activates and suggests a conditional skill whose paths glob matches', () => {
    // Production registers pending conditional skills through
    // registerConditionalSkill (loadSkills does this); mirror that here.
    const skill = makeSkill({
      name: 'docker-helper',
      paths: ['Dockerfile*'],
      isConditional: true,
    });
    getSkillRegistry().register(skill);
    registerConditionalSkill(skill);

    const hits = matchSkillsForPrompt('build the Dockerfile for me');
    expect(hits).toHaveLength(1);
    expect(hits[0].skill.name).toBe('docker-helper');
    expect(hits[0].reason).toBe('path');
    // Activation side effect: no longer conditional-pending.
    expect(hits[0].skill.isConditional).toBe(false);
  });

  it('never suggests hidden or model-invocation-disabled skills by name', () => {
    getSkillRegistry().register(makeSkill({ name: 'secret', isHidden: true }));
    getSkillRegistry().register(makeSkill({ name: 'internal-only', disableModelInvocation: true }));
    expect(matchSkillsForPrompt('use secret and internal-only now')).toHaveLength(0);
  });

  it('honors the exclude set (already-injected popover mentions)', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const hits = matchSkillsForPrompt('use pdf now', { exclude: new Set(['pdf']) });
    expect(hits).toHaveLength(0);
  });

  it('caps suggestions at maxSuggestions', () => {
    for (let i = 0; i < 8; i += 1) {
      getSkillRegistry().register(makeSkill({ name: `alpha-${i}` }));
    }
    const hits = matchSkillsForPrompt(
      'alpha-0 alpha-1 alpha-2 alpha-3 alpha-4 alpha-5 alpha-6 alpha-7',
      { maxSuggestions: 3 },
    );
    expect(hits).toHaveLength(3);
  });

  it('returns nothing for empty prompts', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    expect(matchSkillsForPrompt('   ')).toHaveLength(0);
  });
});

describe('buildSkillSuggestionInjection', () => {
  it('returns null when no hits', () => {
    expect(buildSkillSuggestionInjection([])).toBeNull();
  });

  it('builds a bounded skill-suggestion envelope', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    const hits = matchSkillsForPrompt('use pdf please');
    const injection = buildSkillSuggestionInjection(hits);
    expect(injection).not.toBeNull();
    expect(injection!.envelope).toBe('skill-suggestion');
    expect(injection!.body).toContain('- pdf: Create and inspect PDF documents. (matched by name)');
  });

  it('clamps long descriptions to one line', () => {
    const injection = buildSkillSuggestionInjection([
      {
        skill: makeSkill({ name: 'big', description: `${'x'.repeat(300)}\nsecond line` }),
        reason: 'name',
      },
    ]);
    expect(injection!.body).toContain('big:');
    expect(injection!.body).not.toContain('second line');
    expect(injection!.body).toContain('…');
  });
});
