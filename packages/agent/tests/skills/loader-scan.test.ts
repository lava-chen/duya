/**
 * Loader scan behavior:
 *  - noise directories (node_modules, .git, dot-dirs) are never descended into
 *  - nested category discovery (DESCRIPTION.md dirs) still works
 *  - Agent Skills spec violations (name > 64 / description > 1024 chars)
 *    produce a loud diagnostic but do NOT drop the skill
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSkillRegistry } from '../../src/skills/registry.js';
import { clearConditionalSkills } from '../../src/skills/conditionalSkills.js';
import { loadSkillsFromDirectory } from '../../src/skills/loader.js';

const SIMPLE_SKILL = '---\ndescription: A harmless test skill\n---\n\nDo things.\n';

function makeSkillDir(root: string, segments: string[], content = SIMPLE_SKILL): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}

describe('loadSkillsFromDirectory scanning', () => {
  let root: string;

  beforeEach(() => {
    resetSkillRegistry();
    clearConditionalSkills();
    root = mkdtempSync(join(tmpdir(), 'duya-loader-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    resetSkillRegistry();
    clearConditionalSkills();
  });

  it('skips node_modules, .git, and other noise directories', async () => {
    makeSkillDir(root, ['node_modules', 'evil-pkg', 'SKILL.md']);
    makeSkillDir(root, ['.git', 'hooks', 'SKILL.md']);
    makeSkillDir(root, ['dist', 'bundle', 'SKILL.md']);
    makeSkillDir(root, ['real-skill']);

    const skills = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const names = skills.map((s) => s.name);

    expect(names).toContain('real-skill');
    expect(names).not.toContain('evil-pkg');
    expect(names).not.toContain('hooks');
    expect(names).not.toContain('bundle');
    expect(names).toHaveLength(1);
  });

  it('still discovers nested category skills', async () => {
    const categoryDir = join(root, 'development');
    mkdirSync(categoryDir, { recursive: true });
    writeFileSync(
      join(categoryDir, 'DESCRIPTION.md'),
      '---\ndescription: Development skills\n---\n',
    );
    makeSkillDir(categoryDir, ['tdd']);

    const skills = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);

    expect(skills.map((s) => s.name)).toContain('tdd');
    expect(skills.find((s) => s.name === 'tdd')?.category).toBe('development');
  });

  it('warns on over-long names and descriptions without dropping the skill', async () => {
    const longName = 'a'.repeat(70);
    makeSkillDir(root, [longName]);
    const longDesc = `---\ndescription: ${'d'.repeat(1100)}\n---\n\nBody.\n`;
    makeSkillDir(root, ['loud-desc'], longDesc);

    const skills = await loadSkillsFromDirectory(root, 'user', undefined, undefined, undefined, true);
    const names = skills.map((s) => s.name);

    expect(names).toContain(longName);
    expect(names).toContain('loud-desc');

    const warnings = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(warnings).toContain('exceeds 64 chars');
    expect(warnings).toContain('description exceeds 1024 chars');
  });
});
