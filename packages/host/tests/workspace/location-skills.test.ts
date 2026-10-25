import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pluginDb, settingDb } from '../../src/worker-db-client.js';
import { refreshLocationSkills } from '../../src/worker-execution/location-skills.js';
import { getSkillRegistry } from '../../src/skills/index.js';
import { tempDir } from './fixtures.js';

afterEach(() => vi.restoreAllMocks());

describe('directory-scoped skill refresh', () => {
  it('replaces source project skills with target project skills using the real loader', async () => {
    vi.spyOn(pluginDb, 'registryList').mockResolvedValue([]);
    vi.spyOn(settingDb, 'getJson').mockResolvedValue({});
    const source = tempDir('duya-source-skills-');
    const target = tempDir('duya-target-skills-');
    for (const [cwd, name] of [[source, 'cursor-source-skill'], [target, 'cursor-target-skill']] as const) {
      const directory = path.join(cwd, '.duya', 'skills', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Local project formatting instructions.\n---\nUse the project's formatting conventions.\n`);
    }
    await refreshLocationSkills(source);
    expect(getSkillRegistry().get('cursor-source-skill')?.source).toBe('project');
    await refreshLocationSkills(target);
    expect(getSkillRegistry().get('cursor-source-skill')).toBeUndefined();
    expect(getSkillRegistry().get('cursor-target-skill')?.source).toBe('project');
  });
});
