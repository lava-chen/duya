/**
 * Skills-metadata section .hbs byte-level parity test — Plan 550 1d-rest.
 *
 * The legacy `formatSkillCatalog(skills)` builds the entire body —
 * XML `<available_skills>` block + optional `### Skill roots` table +
 * trailing usage line. `pickCatalogTier` selects full / compact /
 * alias-only against a 1500-token budget. The .hbs is a thin
 * pass-through: the mapper calls `getSkillsMetadataSection(ctx)`
 * synchronously and substitutes `{{skill_catalog_body}}`.
 *
 * Skills injection: the legacy function reads from the global
 * `getSkillRegistry()` singleton. The mapper also calls it (via
 * `getSkillsMetadataSection`). Tests bypass the global registry by
 * passing an explicit `skills` override via the second parameter.
 * Since the mapper can't accept per-call options, the parity test
 * compares TS output against .hbs output under **both** paths — the
 * TS path uses the override, the .hbs path uses the empty
 * default registry. That difference is intentional: the test pins
 * the byte-level output the TS path emits when called with the
 * override, and the .hbs path emits when called with the same
 * override is verified separately via the registry reset trick.
 *
 * Five cases:
 *   1. Tools missing (no READ or SKILL) — section omitted, returns null.
 *   2. Empty skill list — section omitted, returns null.
 *   3. Small skill list (1 system + 1 other) — fits `full` tier.
 *   4. Large skill list (>10 entries) — drops to `compact` / `alias-only`.
 *   5. Skill with very long description — clamps to 250 chars.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { getSkillsMetadataSection } from '../../../../src/prompts/sections/dynamic/skillsMetadata.js';
import { resetSkillRegistry, getSkillRegistry } from '../../../../src/skills/registry.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import type { PromptSkill } from '../../../../src/skills/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function ctxWith(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Skill']),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

function makeSkill(name: string, source: 'system' | 'user' | 'plugin' = 'user', description = 'A test skill'): PromptSkill {
  return {
    name,
    description,
    source,
    isHidden: false,
    disableModelInvocation: false,
    isConditional: false,
    skillRoot: `C:\\skills\\${name}`,
  };
}

describe('skills-metadata hbs byte-level parity (Plan 550 1d-rest)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  function check(skills: PromptSkill[], overrides: Partial<PromptContext> = {}) {
    const ctx = ctxWith(overrides);

    // TS path: pass skills via override so we control exactly what's emitted.
    const ts = getSkillsMetadataSection(ctx, { skills });

    // .hbs path: the mapper always calls the function with no override, so
    // it consults the global registry. Reset it, register the same skills,
    // then render the .hbs.
    resetSkillRegistry();
    const registry = getSkillRegistry();
    for (const skill of skills) registry.register(skill);

    const hbs = system.renderStaticTemplate('dynamic/skills-metadata.hbs', ctx).trim();
    const hbsNorm = hbs === '' ? null : hbs;

    expect(hbsNorm).toBe(ts);

    // Cleanup so other tests don't see the leaked skills.
    resetSkillRegistry();
  }

  it('omits the section when READ and SKILL tools are both absent', () => {
    check([], { enabledTools: new Set<string>(['Edit', 'Write']) });
  });

  it('omits the section when the skill list is empty', () => {
    check([]);
  });

  it('renders the full tier for a small skill list (1 system + 1 other)', () => {
    check([
      makeSkill('plan-task', 'system', 'Plan execution'),
      makeSkill('code-review', 'user', 'Review code changes'),
    ]);
  });

  it('renders the compact / alias-only tier when the catalog exceeds budget', () => {
    const many: PromptSkill[] = [];
    for (let i = 0; i < 25; i += 1) {
      many.push(makeSkill(`skill-${i}`, 'user', 'A reasonably long description for skill ' + i + ' that includes enough words to push the catalog toward the budget limit and exercise the tier-selection algorithm.'));
    }
    check(many);
  });

  it('clamps long descriptions to MAX_LISTING_DESC_CHARS (250)', () => {
    const longDesc = 'x'.repeat(800);
    check([makeSkill('long-desc-skill', 'user', longDesc)]);
    // Spot-check: TS path clamps; verify directly.
    const ctx = ctxWith();
    const ts = getSkillsMetadataSection(ctx, { skills: [makeSkill('long-desc-skill', 'user', longDesc)] });
    expect(ts).toContain('…');
    expect(ts!.match(/x/g)?.length ?? 0).toBeLessThanOrEqual(250);
  });
});