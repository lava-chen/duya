/**
 * packages/agent/tests/skills/system-skills.test.ts
 *
 * System-level skills (`.system`) — always loaded, trusted (security scan
 * skipped), visible to the agent. Modeled after Codex's
 * `~/.codex/skills/.system/` mechanism.
 *
 * Key guarantees under test:
 *  - `loadSystemSkills()` loads every `.system` skill with `source='system'`
 *    and registers it in the global registry.
 *  - System skills skip the security scan: self-knowledge references
 *    AGENTS.md/CLAUDE.md, which trips the critical `agent_config_mod`
 *    scanner pattern — it must still load.
 *  - System skills appear in the model-invocable set (agent catalog).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadSystemSkills,
  getSystemSkillsDir,
} from '../../src/skills/loader.js';
import {
  getSkillRegistry,
  resetSkillRegistry,
} from '../../src/skills/registry.js';
import { scanSkillFile } from '../../src/security/skillScanner.js';

const SYSTEM_SKILL_NAMES = ['self-config', 'self-knowledge', 'plugin-mcp-builder'];

describe('System-level skills (.system)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it('getSystemSkillsDir points at <bundledSkillsDir>/.system', () => {
    const dir = getSystemSkillsDir();
    expect(dir.endsWith(join('skills', '.system'))).toBe(true);
  });

  it('loadSystemSkills loads every system skill with source=system and registers them', async () => {
    const skills = await loadSystemSkills();
    expect(skills.length).toBeGreaterThanOrEqual(SYSTEM_SKILL_NAMES.length);

    const names = skills.map((s) => s.name);
    for (const expected of SYSTEM_SKILL_NAMES) {
      expect(names).toContain(expected);
    }

    for (const skill of skills) {
      expect(skill.source).toBe('system');
      expect(getSkillRegistry().has(skill.name)).toBe(true);
    }
  });

  it('system skills skip the security scan (critical findings do not block loading)', async () => {
    // self-knowledge references AGENTS.md / CLAUDE.md, which trips the
    // critical `agent_config_mod` scanner pattern. Because system skills
    // are trusted and skip scanning, the skill must still load.
    const md = await readFile(
      join(getSystemSkillsDir(), 'self-knowledge', 'SKILL.md'),
      'utf-8',
    );
    const findings = scanSkillFile(md, 'SKILL.md');
    expect(findings.some((f) => f.severity === 'critical' && f.patternId === 'agent_config_mod')).toBe(true);

    const skills = await loadSystemSkills();
    expect(skills.some((s) => s.name === 'self-knowledge')).toBe(true);
  });

  it('system skills are model-invocable (visible in the agent skill catalog)', async () => {
    await loadSystemSkills();
    const names = getSkillRegistry().listModelInvocable().map((s) => s.name);
    for (const expected of SYSTEM_SKILL_NAMES) {
      expect(names).toContain(expected);
    }
  });
});
