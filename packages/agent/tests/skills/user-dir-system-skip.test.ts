/**
 * packages/agent/tests/skills/user-dir-system-skip.test.ts
 *
 * Plan 434: a `.system` directory synced into a user/project skills
 * directory (e.g. `~/.duya/skills/.system/`) must NOT be loaded from there.
 * System-level skills are loaded exclusively from the bundled directory via
 * `loadSystemSkills()` (source 'system', security scan skipped). Loading the
 * user-dir copy instead would scan it as 'user' source — system skills are
 * the only skills trusted to skip scanning — and would double-register.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// os.homedir() is a non-configurable ESM namespace export, so vi.spyOn fails.
// Mock the module instead, preserving all other os functions.
vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: vi.fn() };
});

import { loadSkills } from '../../src/skills/loader.js';
import { getSkillRegistry, resetSkillRegistry } from '../../src/skills/registry.js';

const BENIGN_SYSTEM_SKILL = `---
name: fake-system-skill
description: A fake system skill that must never load from the user dir.
---

# Fake

Instructions.
`;

describe('user-dir .system copy is skipped', () => {
  let home: string;
  let userSkillsDir: string;

  beforeEach(() => {
    resetSkillRegistry();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-home-'));
    userSkillsDir = path.join(home, '.duya', 'skills');
    fs.mkdirSync(path.join(userSkillsDir, '.system', 'fake-system-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(userSkillsDir, '.system', 'fake-system-skill', 'SKILL.md'),
      BENIGN_SYSTEM_SKILL,
      'utf-8',
    );
    (os.homedir as ReturnType<typeof vi.fn>).mockReturnValue(home);
    // Vitest pool workers expose a process.send channel that is not the
    // agent IPC channel; disable it so the loader's db-client takes the
    // "not in agent mode" path and loadDisabledSkillNamesFromSettings
    // falls back to defaults instead of sending a db:request.
    (process as unknown as { send?: unknown }).send = undefined;
  });

  afterEach(() => {
    resetSkillRegistry();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('does not load .system skills from the user skills directory', async () => {
    await loadSkills(home, { syncBundled: false });

    const names = getSkillRegistry().list().map((skill) => skill.name);
    expect(names).not.toContain('fake-system-skill');
  });

  it('still loads the bundled system skills from the agent package', async () => {
    await loadSkills(home, { syncBundled: false });

    const systemSkills = getSkillRegistry().list().filter((skill) => skill.source === 'system');
    expect(systemSkills.length).toBeGreaterThanOrEqual(3);
    expect(systemSkills.map((skill) => skill.name)).toContain('self-config');
  });
});
