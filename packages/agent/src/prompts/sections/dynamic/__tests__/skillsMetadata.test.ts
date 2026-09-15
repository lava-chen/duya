/**
 * skillsMetadata.test.ts
 *
 * The `<available_skills>` XML catalog (pi-style) contract:
 *  - structured XML with name / description / location per skill
 *  - system skills (source === 'system') sort before all others
 *  - section is injected only when Skill or read is available
 *  - XML special characters are escaped
 *  - location is omitted when the loader recorded no skillRoot
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type { PromptSkill } from '../../../../skills/types.js';
import { getSkillRegistry, resetSkillRegistry } from '../../../../skills/registry.js';
import {
  formatSkillCatalog,
  getSkillsMetadataSection,
} from '../skillsMetadata.js';
import type { PromptContext } from '../../../types.js';

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'pdf',
    description: 'Create and inspect PDF documents.',
    source: 'bundled',
    skillRoot: 'E:\\skills\\pdf',
    getPromptForCommand: async () => 'instructions',
    ...overrides,
  };
}

function context(enabledTools: string[] = []): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  };
}

describe('skillsMetadata (pi-style <available_skills> catalog)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('emits structured XML with name, description, and location per skill', () => {
    const catalog = formatSkillCatalog([makeSkill()]);

    expect(catalog).toContain('<available_skills>');
    expect(catalog).toContain('<skill>');
    expect(catalog).toContain('<name>pdf</name>');
    expect(catalog).toContain('<description>Create and inspect PDF documents.</description>');
    expect(catalog).toContain(`<location>${join('E:\\skills\\pdf', 'SKILL.md')}</location>`);
    expect(catalog).toContain('</available_skills>');
  });

  it('sorts system skills (DUYA itself) before all other skills', () => {
    const catalog = formatSkillCatalog([
      makeSkill({ name: 'pdf' }),
      makeSkill({ name: 'memory-search', source: 'system' }),
      makeSkill({ name: 'self-config', source: 'system' }),
      makeSkill({ name: 'arxiv' }),
    ]);

    const systemIndex = catalog.indexOf('<name>memory-search</name>');
    const selfConfigIndex = catalog.indexOf('<name>self-config</name>');
    const pdfIndex = catalog.indexOf('<name>pdf</name>');
    const arxivIndex = catalog.indexOf('<name>arxiv</name>');

    expect(systemIndex).toBeGreaterThan(-1);
    expect(selfConfigIndex).toBeGreaterThan(-1);
    expect(pdfIndex).toBeGreaterThan(-1);
    expect(arxivIndex).toBeGreaterThan(-1);
    expect(systemIndex).toBeLessThan(pdfIndex);
    expect(selfConfigIndex).toBeLessThan(arxivIndex);
    // Within the system group, ordering is alphabetical (m before s).
    expect(systemIndex).toBeLessThan(selfConfigIndex);
  });

  it('escapes XML special characters in names, descriptions, and locations', () => {
    const catalog = formatSkillCatalog([
      makeSkill({
        name: 'a&b',
        description: 'uses <angle> & "quotes" and \'apostrophes\'',
        skillRoot: 'E:\\skills\\x&y',
      }),
    ]);

    expect(catalog).toContain('<name>a&amp;b</name>');
    expect(catalog).toContain('&lt;angle&gt; &amp; &quot;quotes&quot; and &apos;apostrophes&apos;');
    expect(catalog).toContain('<location>E:\\skills\\x&amp;y\\SKILL.md</location>');
  });

  it('omits location when the loader recorded no skillRoot', () => {
    const catalog = formatSkillCatalog([makeSkill({ skillRoot: undefined })]);
    expect(catalog).toContain('<name>pdf</name>');
    // The usage line mentions <location> as literal guidance text, but no
    // <skill> block may carry a location element.
    expect(catalog).not.toMatch(/<skill>[\s\S]*?<location>[\s\S]*?<\/skill>/);
  });

  it('returns null when neither Skill nor read is available', () => {
    getSkillRegistry().register(makeSkill());
    expect(getSkillsMetadataSection(context([]))).toBeNull();
    expect(getSkillsMetadataSection(context(['Bash']))).toBeNull();
  });

  it('injects the catalog when only read is available (pi-style loading)', () => {
    getSkillRegistry().register(makeSkill());
    const section = getSkillsMetadataSection(context(['Read']));
    expect(section).not.toBeNull();
    expect(section).toContain('<name>pdf</name>');
  });

  it('injects the catalog when only the Skill tool is available (fallback)', () => {
    getSkillRegistry().register(makeSkill());
    const section = getSkillsMetadataSection(context(['Skill']));
    expect(section).not.toBeNull();
    expect(section).toContain('<name>pdf</name>');
  });

  it('returns null when no skill is model-invocable', () => {
    getSkillRegistry().register(makeSkill({ isHidden: true }));
    expect(getSkillsMetadataSection(context(['Read']))).toBeNull();
  });

  it('truncates descriptions beyond the 250-char listing budget', () => {
    const long = 'x'.repeat(400);
    const catalog = formatSkillCatalog([makeSkill({ description: long })]);

    // Clamped to MAX_LISTING_DESC_CHARS (250) incl. ellipsis, XML-escaped.
    const expected = 'x'.repeat(249) + '…';
    expect(catalog).toContain(`<description>${expected}</description>`);
    expect(catalog).not.toContain('x'.repeat(250));
  });

  it('keeps descriptions within budget untouched', () => {
    const catalog = formatSkillCatalog([makeSkill({ description: 'short' })]);
    expect(catalog).toContain('<description>short</description>');
  });

  it('emits a ### Skill roots alias table mapping names to SKILL.md paths', () => {
    const catalog = formatSkillCatalog([
      makeSkill({ name: 'pdf', skillRoot: 'E:\\skills\\pdf' }),
      makeSkill({ name: 'xlsx', skillRoot: 'E:\\skills\\xlsx' }),
    ]);

    expect(catalog).toContain('### Skill roots');
    expect(catalog).toContain('| Skill | Source |');
    expect(catalog).toContain('| pdf | E:\\skills\\pdf\\SKILL.md |');
    expect(catalog).toContain('| xlsx | E:\\skills\\xlsx\\SKILL.md |');
  });

  it('omits ### Skill roots when no skill has a recorded skillRoot', () => {
    const catalog = formatSkillCatalog([
      makeSkill({ name: 'pdf', skillRoot: undefined }),
    ]);

    expect(catalog).not.toContain('### Skill roots');
  });

  it('renders full tier (name + description + location) when budget is generous', () => {
    // 60k token budget — every small skill list fits comfortably.
    const catalog = formatSkillCatalog(
      [makeSkill()],
      { tokens: 60_000, charsPerToken: 0.25 },
    );

    expect(catalog).toContain('<name>pdf</name>');
    expect(catalog).toContain('<description>');
    expect(catalog).toContain('<location>');
  });

  it('falls back to compact tier (no <location>) when budget is mid', () => {
    // Build a skill list whose full-tier estimate exceeds the 70% headroom
    // threshold but stays under 100% — exercises the compact branch.
    // 4 skills × ~340 chars compact (name + 250 desc + wrapper) = ~1360 chars
    // + ~510 fixed overhead ≈ 1870 chars compact. Budget 500 tokens =
    // 2000 chars → 70% threshold 1400 (compact crosses it → not full),
    // 100% threshold 2000 (compact fits → compact tier fires).
    const skills = Array.from({ length: 4 }, (_, i) =>
      makeSkill({ name: `s${i}`, description: 'x'.repeat(250) }),
    );
    const catalog = formatSkillCatalog(skills, { tokens: 500, charsPerToken: 0.25 });

    expect(catalog).not.toMatch(/<skill>[\s\S]*?<location>[\s\S]*?<\/skill>/);
    expect(catalog).toContain('<description>');
    expect(catalog).toContain('### Skill roots');
  });

  it('falls back to alias-only tier (name only) when budget is tiny', () => {
    // Budget so small even compact tier can't fit; aliases only.
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkill({ name: `skill-${i}`, description: 'x'.repeat(250) }),
    );
    const catalog = formatSkillCatalog(skills, { tokens: 50, charsPerToken: 0.25 });

    // Each skill renders only <name>; no <description> tags appear inside <skill>.
    const skillBlocks = catalog.match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
    expect(skillBlocks.length).toBe(5);
    for (const block of skillBlocks) {
      expect(block).not.toContain('<description>');
      expect(block).not.toContain('<location>');
    }
    expect(catalog).toContain('### Skill roots');
  });

  it('keeps system-first ordering inside the ### Skill roots table', () => {
    const catalog = formatSkillCatalog([
      makeSkill({ name: 'pdf' }),
      makeSkill({ name: 'memory-search', source: 'system' }),
      makeSkill({ name: 'arxiv' }),
    ]);

    const rootsStart = catalog.indexOf('### Skill roots');
    const memoryIndex = catalog.indexOf('memory-search', rootsStart);
    const pdfIndex = catalog.indexOf('pdf', rootsStart);
    const arxivIndex = catalog.indexOf('arxiv', rootsStart);

    expect(memoryIndex).toBeLessThan(pdfIndex);
    expect(memoryIndex).toBeLessThan(arxivIndex);
  });
});
