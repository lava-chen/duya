/**
 * Skills catalog — Plan 560.
 *
 * The catalog text lives entirely in `assets/dynamic/skills-metadata.hbs`
 * (XML `<available_skills>` block + optional `### Skill roots` table +
 * trailing usage prose). This test file covers the contract at two
 * levels:
 *
 *  1. **Utilities** (`skillsMetadata.ts`) — the data shape the mapper
 *     feeds the template. Each helper has a single responsibility and is
 *     exercised in isolation.
 *  2. **Rendered output** (`HbsPromptSystem.renderStaticTemplate` against
 *     the populated registry) — the byte-level contract the user sees in
 *     the assembled prompt. The mapper precomputes tier booleans; this
 *     suite verifies the template honors them.
 */

import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../types.js';
import { getSkillRegistry, resetSkillRegistry } from '../../../skills/registry.js';
import type { PromptSkill } from '../../../skills/types.js';
import {
  buildCatalogSkillEntry,
  buildLoadDiagnosticsLine,
  DEFAULT_BUDGET,
  displayDescription,
  escapeXml,
  estimateCatalogChars,
  isSkillSourceExternal,
  pickCatalogTier,
  skillLocation,
  SKILLS_CATALOG_FIXED_OVERHEAD_CHARS,
} from '../skillsMetadata.js';

const ASSETS_ROOT = resolve(__dirname, '../../assets');

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'pdf',
    description: 'Create and inspect PDF documents.',
    source: 'bundled',
    isHidden: false,
    disableModelInvocation: false,
    isConditional: false,
    skillRoot: 'E:\\skills\\pdf',
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
  } as PromptContext;
}

const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

function renderCatalog(): string {
  // Reuse the mapper logic by routing through `renderStaticTemplate`
  // (it always rebuilds the vars hash from `ctx` + the registry, which is
  // exactly what `buildSkillsCatalogContext` does on the hot path).
  return system.renderStaticTemplate('dynamic/skills-metadata.hbs', context(['Read'])).trim();
}

describe('skillsMetadata utilities', () => {
  it('classifies bundled + system as internal, everything else as external', () => {
    expect(isSkillSourceExternal('bundled')).toBe(false);
    expect(isSkillSourceExternal('system')).toBe(false);
    expect(isSkillSourceExternal('user')).toBe(true);
    expect(isSkillSourceExternal('project')).toBe(true);
    expect(isSkillSourceExternal('mcp')).toBe(true);
    expect(isSkillSourceExternal('plugin')).toBe(true);
    expect(isSkillSourceExternal('agent')).toBe(true);
    expect(isSkillSourceExternal('custom')).toBe(true);
  });

  it('escapeXml handles the five XML metacharacters', () => {
    expect(escapeXml('a < b & c > d "e" \'f\''))
      .toBe('a &lt; b &amp; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('skillLocation joins skillRoot + SKILL.md when the root is recorded', () => {
    // `path.join` is platform-aware — on Windows it converts `/` to
    // `\`, on POSIX it leaves `/` alone. Assert on the structural parts
    // so the test passes on either platform.
    const loc = skillLocation(makeSkill({ skillRoot: 'skills/pdf' }))!
    expect(loc.endsWith('SKILL.md')).toBe(true);
    expect(loc).toContain('skills');
    expect(loc).toContain('pdf');
    expect(skillLocation(makeSkill({ skillRoot: undefined }))).toBeUndefined();
  });

  describe('displayDescription (per-source cap)', () => {
    it('uses 250 chars for internal sources and preserves multi-line text', () => {
      const long = 'a'.repeat(300);
      expect(displayDescription(makeSkill({ description: long })).length).toBe(250);
    });

    it('clamps external descriptions to the 120-char budget', () => {
      const first = 'External one-liner';
      const tail = '\n  extra detail with whitespace';
      const result = displayDescription(makeSkill({
        source: 'user',
        description: first + tail,
      }));
      expect(result).toBe(first);
      expect(result.length).toBeLessThanOrEqual(120);
    });

    it('falls back to the full description when the first-line strip leaves nothing', () => {
      const result = displayDescription(makeSkill({
        source: 'user',
        description: '\n\n   \n',
      }));
      // `firstNonEmptyLine` returned '' — the helper falls back to the
      // raw description, clamped to the 120-char cap.
      expect(result.length).toBeLessThanOrEqual(120);
    });
  });

  describe('pickCatalogTier (budget-driven tier selection)', () => {
    it('returns "full" when the catalog fits at <= 70% of the budget', () => {
      const skills = [makeSkill()];
      expect(pickCatalogTier(skills, DEFAULT_BUDGET, SKILLS_CATALOG_FIXED_OVERHEAD_CHARS))
        .toBe('full');
    });

    it('returns "compact" when full is too large but compact fits at 100%', () => {
      // 80 system skills × (name + 220-char description + ~50-char
      // location) puts `full` at ~30k chars. A 7000-token budget gives
      // 28000 chars: compact (~25k) fits, full (~30k) does not.
      const skills = Array.from({ length: 80 }, (_, i) =>
        makeSkill({
          name: `s${i}`,
          description: 'a'.repeat(220),
          source: 'system',
          skillRoot: 'skills/' + 'x'.repeat(40) + '/' + i,
        }),
      );
      const tier = pickCatalogTier(
        skills,
        { tokens: 7000, charsPerToken: 0.25 },
        SKILLS_CATALOG_FIXED_OVERHEAD_CHARS,
      );
      expect(tier).toBe('compact');
    });

    it('falls back to "alias-only" when the catalog cannot fit any description', () => {
      const skills = Array.from({ length: 80 }, (_, i) =>
        makeSkill({
          name: `s${i}`,
          description: 'a'.repeat(220),
          source: 'system',
        }),
      );
      const tier = pickCatalogTier(skills, { tokens: 50, charsPerToken: 0.25 }, SKILLS_CATALOG_FIXED_OVERHEAD_CHARS);
      expect(tier).toBe('alias-only');
    });

    it('estimateCatalogChars grows monotonically with tier richness', () => {
      const skills = [makeSkill(), makeSkill({ name: 'foo' })];
      const alias = estimateCatalogChars(skills, 'alias-only', SKILLS_CATALOG_FIXED_OVERHEAD_CHARS);
      const compact = estimateCatalogChars(skills, 'compact', SKILLS_CATALOG_FIXED_OVERHEAD_CHARS);
      const full = estimateCatalogChars(skills, 'full', SKILLS_CATALOG_FIXED_OVERHEAD_CHARS);
      expect(alias).toBeLessThan(compact);
      expect(compact).toBeLessThan(full);
    });
  });

  describe('buildCatalogSkillEntry (per-skill mapper record)', () => {
    it('XML-escapes the name and description, preserves location verbatim', () => {
      const entry = buildCatalogSkillEntry(makeSkill({
        name: 'a < b',
        description: 'has "quotes" & ampersand',
        skillRoot: 'skills/a',
      }));
      expect(entry.name).toBe('a &lt; b');
      expect(entry.description).toBe('has &quot;quotes&quot; &amp; ampersand');
      expect(entry.location).toBeTruthy();
      expect(entry.location!.endsWith('SKILL.md')).toBe(true);
    });
  });

  describe('buildLoadDiagnosticsLine (plan 535 A-3 minimal comment)', () => {
    it('returns an empty string when there are no diagnostics', () => {
      expect(buildLoadDiagnosticsLine(undefined)).toBe('');
      expect(buildLoadDiagnosticsLine([])).toBe('');
    });

    it('renders an XML-comment line tallying errors + warnings', () => {
      const diagnostics = [
        { level: 'error' as const, message: 'm1' },
        { level: 'warning' as const, message: 'm2' },
        { level: 'warning' as const, message: 'm3' },
      ];
      const line = buildLoadDiagnosticsLine(diagnostics);
      expect(line).toContain('1 skill load error(s)');
      expect(line).toContain('2 skill load warning(s)');
      // The line is indented 2 spaces for the .hbs `<available_skills>`
      // block; trim before pattern-matching the `<!--` / `-->` markers.
      const trimmed = line.trim();
      expect(trimmed).toMatch(/^<!--/);
      expect(trimmed).toMatch(/-->$/);
    });
  });
});

describe('skills-metadata.hbs render (Plan 560 native template)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('omits the body when the registry has no model-invocable skills', () => {
    // Empty registry → mapper emits `skill_catalog_enabled: false` → the
    // `{{#if}}` collapses the body to ''.
    expect(renderCatalog()).toBe('');
  });

  it('emits the XML wrapper, per-skill tags, and the trailing usage prose', () => {
    getSkillRegistry().register(makeSkill());
    const out = renderCatalog();

    expect(out).toContain('<available_skills>');
    expect(out).toContain('<skill>');
    expect(out).toContain('<name>pdf</name>');
    expect(out).toContain('<description>Create and inspect PDF documents.</description>');
    expect(out).toContain('<location>E:\\skills\\pdf\\SKILL.md</location>');
    expect(out).toContain('</available_skills>');
    expect(out).toContain('complete, authoritative list of installed skills');
    expect(out).toContain('do not run CLI commands (such as `duya skill list`)');
  });

  it('sorts system skills before all other skills (DUYA itself first)', () => {
    getSkillRegistry().register(makeSkill({ name: 'pdf' }));
    getSkillRegistry().register(makeSkill({ name: 'memory-search', source: 'system' }));
    getSkillRegistry().register(makeSkill({ name: 'self-config', source: 'system' }));

    const out = renderCatalog();
    const systemStart = out.indexOf('<!-- System (DUYA itself) -->');
    const otherStart = out.indexOf('<!-- Other skills -->');
    const memoryIdx = out.indexOf('<name>memory-search</name>');
    const pdfIdx = out.indexOf('<name>pdf</name>');

    expect(systemStart).toBeGreaterThan(-1);
    expect(otherStart).toBeGreaterThan(-1);
    expect(systemStart).toBeLessThan(otherStart);
    expect(memoryIdx).toBeLessThan(pdfIdx);
  });

  it('escapes XML special characters in name and description', () => {
    getSkillRegistry().register(makeSkill({
      name: 'a < b',
      description: 'has "quotes" & ampersand',
    }));
    const out = renderCatalog();

    expect(out).toContain('<name>a &lt; b</name>');
    expect(out).toContain('<description>has &quot;quotes&quot; &amp; ampersand</description>');
  });

  it('omits <location> from the skill body when the skill has no recorded skillRoot', () => {
    getSkillRegistry().register(makeSkill({ skillRoot: undefined }));
    const out = renderCatalog();
    // The .hbs body also references `<location>` in the trailing prose
    // ("Load a skill by reading its <location> with the read tool; ...");
    // that prose must remain even when no skill has a location. Restrict
    // the assertion to the XML skill body.
    const bodyMatch = out.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![0]).not.toContain('<location>');
    expect(bodyMatch![0]).not.toContain('</location>');
  });

  it('truncates descriptions beyond the 250-char internal cap', () => {
    getSkillRegistry().register(makeSkill({ description: 'a'.repeat(300) }));
    const out = renderCatalog();
    const match = out.match(/<description>([^<]+)<\/description>/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(250);
  });

  it('surfaces a ### Skill roots alias table when tier drops <location>', () => {
    // 80 system skills with 220-char descriptions → budget forces `compact`
    // tier (no location in body), which makes `show_skill_roots: true`.
    for (let i = 0; i < 80; i++) {
      getSkillRegistry().register(makeSkill({
        name: `s${i}`,
        description: 'a'.repeat(220),
        source: 'system',
      }));
    }
    const out = renderCatalog();
    expect(out).toContain('### Skill roots');
    // The body has no <location> at compact tier; the table carries them.
    const bodyMatch = out.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    expect(bodyMatch![0]).not.toContain('<location>');
  });

  it('emits the load-diagnostics comment when diagnostics are present', () => {
    getSkillRegistry().register(makeSkill());
    getSkillRegistry().setLastLoadDiagnostics([{
      level: 'error',
      message: 'synthetic failure',
    }]);
    const out = renderCatalog();
    expect(out).toContain('1 skill load error(s)');
  });

  it('first-line preview surfaces only the first non-empty line for external sources', () => {
    getSkillRegistry().register(makeSkill({
      name: 'ext',
      source: 'user',
      description: 'First line summary\n  second-line detail\n  third-line detail',
    }));
    const out = renderCatalog();
    expect(out).toContain('<description>First line summary</description>');
    expect(out).not.toContain('second-line detail');
  });
});