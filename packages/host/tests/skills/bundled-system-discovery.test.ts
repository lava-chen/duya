import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const settingDbGet = vi.hoisted(() => vi.fn());

vi.mock('../../src/worker-db-client.js', () => ({
  settingDb: { get: settingDbGet },
}));

import { getBundledSkillsDir, loadSystemSkills } from '../../src/skills/loader.js';
import { resetSkillRegistry } from '../../src/skills/registry.js';

describe('bundled system skill discovery', () => {
  afterEach(() => {
    resetSkillRegistry();
    settingDbGet.mockReset();
  });

  it('loads a real Host-bundled .system skill through the default path without IPC sync', async () => {
    const hostBundleRoot = path.resolve(fileURLToPath(new URL('../../skills', import.meta.url)));
    expect(getBundledSkillsDir()).toBe(hostBundleRoot);
    expect(existsSync(path.join(hostBundleRoot, '.system', 'memory-search', 'SKILL.md'))).toBe(true);

    const skills = await loadSystemSkills(true);
    const memorySearch = skills.find((skill) => skill.name === 'memory-search');

    expect(memorySearch).toMatchObject({ name: 'memory-search', source: 'system' });
    expect(settingDbGet).not.toHaveBeenCalled();
  });
});
