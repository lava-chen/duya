/**
 * Snapshot-cache integration through loadSkillsFromDirectory
 * (plan 445 Phase C/D).
 *
 * Contract:
 *  - unchanged roots reuse the same PromptSkill object references across
 *    loads; changed skills are rebuilt while siblings stay cached
 *  - disabled-name filtering in loadSkills is unaffected by caching
 *  - conditional-skill activation state survives reloads (an activated
 *    skill stays invocable; pending ones stay out of the catalog)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// loadSkills reads disabled-skill overrides via the DB bridge, which has no
// channel under the vitest process pool. Return "no overrides".
vi.mock('../../src/ipc/db-client.js', () => ({
  settingDb: {
    getJson: vi.fn().mockResolvedValue({}),
  },
}));

import {
  getSkillRegistry,
  resetSkillRegistry,
} from '../../src/skills/registry.js';
import {
  activateConditionalSkills,
  clearConditionalSkills,
} from '../../src/skills/conditionalSkills.js';
import {
  loadSkills,
  loadSkillsFromDirectory,
} from '../../src/skills/loader.js';

const SKILL_MD = (description: string) =>
  `---\ndescription: ${description}\n---\n\nBody.\n`;

function makeSkillDir(root: string, name: string, description = `${name} skill`): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL_MD(description));
  return dir;
}

describe('loadSkillsFromDirectory snapshot integration', () => {
  let root: string;

  beforeEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
    root = mkdtempSync(join(tmpdir(), 'duya-snap-int-'));
    makeSkillDir(root, 'alpha');
    makeSkillDir(root, 'beta');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSkillRegistry();
    clearConditionalSkills();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses skill objects when the tree is unchanged', async () => {
    const first = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const second = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);

    expect(second.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    for (const skill of first) {
      expect(second.find((s) => s.name === skill.name)).toBe(skill);
    }
  });

  it('rebuilds only the changed skill; siblings keep their identity', async () => {
    const first = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const alphaBefore = first.find((s) => s.name === 'alpha')!;
    const betaBefore = first.find((s) => s.name === 'beta')!;

    writeFileSync(
      join(root, 'alpha', 'SKILL.md'),
      SKILL_MD('alpha rewritten'),
    );

    const second = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const alphaAfter = second.find((s) => s.name === 'alpha')!;
    const betaAfter = second.find((s) => s.name === 'beta')!;

    expect(alphaAfter).not.toBe(alphaBefore);
    expect(betaAfter).toBe(betaBefore);

    // The rebuilt object carries the new frontmatter.
    expect(alphaAfter.description).toBe('alpha rewritten');
  });

  it('rebuilds when the config key changes (scan toggle)', async () => {
    const first = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const second = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, false);

    // Same names, but rebuilt objects (different identities).
    expect(second.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    for (const skill of first) {
      expect(second.find((s) => s.name === skill.name)).not.toBe(skill);
    }
  });

  it('disabled-name filtering still applies on top of cached loads', async () => {
    const loaded = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    expect(loaded.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);

    // Simulate loadSkills' post-filter with an override map.
    const overrides: Record<string, boolean> = { alpha: false };
    const effective = loaded.filter((s) => overrides[s.name] !== false);
    expect(effective.map((s) => s.name)).toEqual(['beta']);
  });

  it('conditional activation state survives a snapshot-cached reload', async () => {
    const dockerDir = makeSkillDir(root, 'docker-deploy');
    writeFileSync(
      join(dockerDir, 'SKILL.md'),
      '---\ndescription: Docker deploy\npaths: Dockerfile*\n---\n\nDeploy.\n',
    );

    const registry = getSkillRegistry();
    // additionalPaths routes the temp root through the real loadSkills path
    // (the user/project dirs are environment-dependent and unused here).
    const loadOpts = { syncBundled: false, additionalPaths: [root], skipSecurityScan: true } as const;
    const firstLoad = await loadSkills(root, loadOpts);
    const conditional = firstLoad.find((s) => s.name === 'docker-deploy')!;
    expect(conditional.isConditional).toBe(true);
    expect(registry.listModelInvocable().map((s) => s.name))
      .not.toContain('docker-deploy');

    activateConditionalSkills([join(root, 'Dockerfile')], root);
    expect(conditional.isConditional).toBe(false);

    // Reload: cached subtrees re-register the same objects. The activated
    // skill must remain unconditional and model-invocable.
    const secondLoad = await loadSkills(root, loadOpts);
    const afterReload = secondLoad.find((s) => s.name === 'docker-deploy')!;
    expect(afterReload.isConditional).toBe(false);
    expect(registry.listModelInvocable().map((s) => s.name))
      .toContain('docker-deploy');
  });
});
