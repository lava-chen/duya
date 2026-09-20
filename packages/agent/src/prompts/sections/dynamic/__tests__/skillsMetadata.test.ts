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
  isSkillSourceExternal,
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

  it('declares the catalog as the authoritative inventory source (plan 535 A-5)', () => {
    const catalog = formatSkillCatalog([makeSkill()]);

    // The model must answer "what skills do you have" from this block
    // instead of running discovery commands like `duya skill list`.
    expect(catalog).toContain('complete, authoritative list of installed skills');
    expect(catalog).toContain('do not run CLI commands (such as `duya skill list`)');
    expect(catalog).toContain('answer directly from it');
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

  it('ignores tool availability — presence gating lives in PromptSystem.requiresTools (plan 557 phase 3)', () => {
    getSkillRegistry().register(makeSkill());
    // Plan 557 moved the Read/Skill presence gate to SectionDef.requiresTools
    // (checked centrally, case-insensitively). The function itself now only
    // reflects data availability.
    expect(getSkillsMetadataSection(context([]))).not.toBeNull();
    expect(getSkillsMetadataSection(context(['Bash']))).not.toBeNull();
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
    // + ~990 fixed overhead (incl. the authoritative-inventory usage line)
    // ≈ 2370 chars compact. Budget 700 tokens = 2800 chars →
    // 70% threshold 1960 (full crosses it → not full),
    // 100% threshold 2800 (compact fits → compact tier fires).
    const skills = Array.from({ length: 4 }, (_, i) =>
      makeSkill({ name: `s${i}`, description: 'x'.repeat(250) }),
    );
    const catalog = formatSkillCatalog(skills, { tokens: 700, charsPerToken: 0.25 });

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

  // --- Phase A-2: mcode-aligned budget + external/internal split ---

  describe('isSkillSourceExternal (mcode sourceExternal parity)', () => {
    it('treats bundled and system as internal', () => {
      expect(isSkillSourceExternal('bundled')).toBe(false);
      expect(isSkillSourceExternal('system')).toBe(false);
    });

    it('treats user / project / mcp / plugin / agent as external', () => {
      expect(isSkillSourceExternal('user')).toBe(true);
      expect(isSkillSourceExternal('project')).toBe(true);
      expect(isSkillSourceExternal('mcp')).toBe(true);
      expect(isSkillSourceExternal('plugin')).toBe(true);
      expect(isSkillSourceExternal('agent')).toBe(true);
    });

    it('treats custom (additional skill_path) as external', () => {
      expect(isSkillSourceExternal('custom')).toBe(true);
    });
  });

  describe('first-line preview for external descriptions (mcode firstDescriptionLine)', () => {
    it('renders only the first non-empty line for external skills', () => {
      const catalog = formatSkillCatalog([
        makeSkill({
          name: 'ext',
          source: 'plugin',
          description: 'First line here.\nSecond line with more details.\nThird line.',
        }),
      ]);

      expect(catalog).toContain('<description>First line here.</description>');
      expect(catalog).not.toContain('Second line');
    });

    it('keeps the full (250-clamped) description for internal skills', () => {
      const catalog = formatSkillCatalog([
        makeSkill({
          name: 'int',
          source: 'bundled',
          description: 'First line here.\nSecond line with more details.',
        }),
      ]);

      expect(catalog).toContain('<description>First line here.\nSecond line with more details.</description>');
    });

    it('falls back to the full description when every line is blank', () => {
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'ext', source: 'user', description: '\n \nplain\n' }),
      ]);
      expect(catalog).toContain('<description>plain</description>');
    });

    it('clamps a long first line to the external 120-char cap', () => {
      const first = 'x'.repeat(300);
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'ext', source: 'plugin', description: `${first}\nsecond` }),
      ]);
      const expected = 'x'.repeat(119) + '…';
      expect(catalog).toContain(`<description>${expected}</description>`);
      expect(catalog).not.toContain('second');
    });
  });

  describe('load diagnostics count line (plan 535 A-3)', () => {
    it('renders a bounded count comment when diagnostics exist', () => {
      const diagnostics = [
        { level: 'error' as const, code: 'skill_read_failed' as const, name: 'a', locationUri: 'E:\\x\\a\\SKILL.md', message: 'boom' },
        { level: 'warning' as const, code: 'skill_symlink_rejected' as const, name: 'b', locationUri: 'E:\\x\\b\\SKILL.md', message: 'symlink' },
      ];
      const catalog = formatSkillCatalog([makeSkill()], undefined, { loadDiagnostics: diagnostics });

      expect(catalog).toContain('<!-- 1 skill load error(s), 1 skill load warning(s)');
      // Prompt-injection hardening: no paths, no messages, no codes.
      expect(catalog).not.toContain('E:\\x');
      expect(catalog).not.toContain('boom');
      expect(catalog).not.toContain('symlink');
      expect(catalog).not.toContain('skill_read_failed');
    });

    it('renders no comment when diagnostics are empty', () => {
      const catalog = formatSkillCatalog([makeSkill()], undefined, { loadDiagnostics: [] });
      expect(catalog).not.toContain('<!-- 1 skill load');
      expect(catalog).not.toMatch(/load (error|warning)\(s\)/);
    });

    it('surfaces registry-stored diagnostics through getSkillsMetadataSection', () => {
      getSkillRegistry().register(makeSkill());
      getSkillRegistry().setLastLoadDiagnostics([
        { level: 'error', code: 'skill_read_failed', locationUri: 'E:\\x', message: 'boom' },
      ]);
      const section = getSkillsMetadataSection(context(['Read']));
      expect(section).not.toBeNull();
      expect(section).toContain('1 skill load error(s)');

      getSkillRegistry().setLastLoadDiagnostics([]);
      const clean = getSkillsMetadataSection(context(['Read']));
      expect(clean).not.toBeNull();
      expect(clean).not.toMatch(/skill load (error|warning)\(s\)/);
    });
  });

  describe('description cap differentiation', () => {
    it('truncates external skill descriptions at 120 chars (mcode DEFAULT_EXTERNAL_DESCRIPTION_CHARS)', () => {
      const long = 'x'.repeat(400);
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'ext', source: 'plugin', description: long }),
      ]);

      // Clamped to 120 incl. ellipsis, XML-escaped.
      const expected = 'x'.repeat(119) + '…';
      expect(catalog).toContain(`<description>${expected}</description>`);
      expect(catalog).not.toContain('x'.repeat(120));
    });

    it('keeps internal (bundled) skill descriptions at 250 chars', () => {
      const long = 'x'.repeat(400);
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'int', source: 'bundled', description: long }),
      ]);

      // Clamped to 250 incl. ellipsis, XML-escaped.
      const expected = 'x'.repeat(249) + '…';
      expect(catalog).toContain(`<description>${expected}</description>`);
      expect(catalog).not.toContain('x'.repeat(250));
    });

    it('applies the per-source cap independently in a mixed list', () => {
      // Use distinct fill chars so the substring counts are unambiguous:
      // 'A' for internal caps and 'E' for external caps.
      const longA = 'A'.repeat(400);
      const longE = 'E'.repeat(400);
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'int', source: 'bundled', description: longA }),
        makeSkill({ name: 'sys', source: 'system', description: longA }),
        makeSkill({ name: 'usr', source: 'user', description: longE }),
        makeSkill({ name: 'plg', source: 'plugin', description: longE }),
        makeSkill({ name: 'ag', source: 'agent', description: longE }),
      ]);

      const expected250 = 'A'.repeat(249) + '…';
      const expected120 = 'E'.repeat(119) + '…';

      // Per-skill <description> blocks: extract each block and verify the
      // truncation that the renderer chose for its source.
      const blocks = catalog.match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
      const blockFor = (name: string) =>
        blocks.find(b => b.includes(`<name>${name}</name>`)) ?? '';

      expect(blockFor('int')).toContain(`<description>${expected250}</description>`);
      expect(blockFor('sys')).toContain(`<description>${expected250}</description>`);
      expect(blockFor('usr')).toContain(`<description>${expected120}</description>`);
      expect(blockFor('plg')).toContain(`<description>${expected120}</description>`);
      expect(blockFor('ag')).toContain(`<description>${expected120}</description>`);
    });

    it('keeps short external descriptions untouched', () => {
      const catalog = formatSkillCatalog([
        makeSkill({ name: 'ext', source: 'user', description: 'short' }),
      ]);
      expect(catalog).toContain('<description>short</description>');
    });
  });

  describe('mcode-aligned budget (5000 tokens / 20000 chars)', () => {
    it('renders 22 bundled skills at full tier under default budget', () => {
      // Phase A budget (1500 tokens) forced these to compact; Phase A-2
      // (5000 tokens, mcode-aligned) keeps every skill at full tier with
      // name + description + location.
      const skills = Array.from({ length: 22 }, (_, i) =>
        makeSkill({ name: `bundled-${i}`, description: 'A bundled skill.' }),
      );
      const catalog = formatSkillCatalog(skills);

      // Each skill renders name + description + location at full tier.
      const skillBlocks = catalog.match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
      expect(skillBlocks.length).toBe(22);
      for (const block of skillBlocks) {
        expect(block).toContain('<name>');
        expect(block).toContain('<description>');
        expect(block).toContain('<location>');
      }
    });

    it('does not regress the old 1500-token tier behavior when budget is forced low', () => {
      // Same input as above but force the budget back to Phase A's 1500
      // tokens AND pad each description so full tier exceeds the 70%
      // headroom threshold. This forces compact (no <location>) and
      // proves the new default budget is what unlocks full tier, not the
      // per-skill cap.
      const skills = Array.from({ length: 22 }, (_, i) =>
        makeSkill({ name: `bundled-${i}`, description: 'A bundled skill. '.repeat(20) }),
      );
      const catalog = formatSkillCatalog(skills, {
        tokens: 1500,
        charsPerToken: 0.25,
      });

      const skillBlocks = catalog.match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
      expect(skillBlocks.length).toBe(22);
      for (const block of skillBlocks) {
        expect(block).not.toContain('<location>');
      }
    });
  });
});
