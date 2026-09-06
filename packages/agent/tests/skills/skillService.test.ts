/**
 * packages/agent/tests/skills/skillService.test.ts
 *
 * Plan 435 — CLI display-layer unification: `listSkillDTOs` must cover
 * every skill source the GUI shows (user / project / custom / system /
 * plugin / bundled), system skills are always enabled, and the resolver
 * precedence keeps system on top.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  effectivePrecedenceOf,
  pickWinner,
  type SkillCandidate,
} from '../../src/skills/resolver.js';
import {
  listSkillDTOs,
  getSkillInfoDTO,
  type SkillListItem,
} from '../../src/skills/skillService.js';

function writeSkill(dir: string, name: string, description: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8',
  );
  return skillDir;
}

function baseArgs(overrides: Record<string, boolean> = {}) {
  return {
    userSkillsDir: '',
    pluginInstallPaths: {} as Record<string, string>,
    overrides,
  };
}

describe('resolver precedence (plan 435)', () => {
  it('ranks system above custom, agent, user/project, plugin, and bundled', () => {
    const cases: Array<[SkillCandidate, number]> = [
      [{ name: 'x', origin: 'system' }, 6],
      [{ name: 'x', origin: 'custom' }, 5],
      [{ name: 'x', origin: 'agent' }, 4],
      [{ name: 'x', origin: 'user' }, 3],
      [{ name: 'x', origin: 'project' }, 3],
      [{ name: 'x', origin: 'plugin' }, 2],
      [{ name: 'x', origin: 'bundled', hasMarker: true }, 2],
      [{ name: 'x', origin: 'bundled', hasMarker: false }, 1],
    ];
    for (const [candidate, expected] of cases) {
      expect(effectivePrecedenceOf(candidate)).toBe(expected);
    }
  });

  it('picks the agent winner over a global user skill with the same name', () => {
    const winner = pickWinner([
      { name: 'my-skill', origin: 'user' },
      { name: 'my-skill', origin: 'agent' },
    ]);
    expect(winner?.origin).toBe('agent');
    expect(winner?.effectivePrecedence).toBe(4);
  });

  it('picks the system skill over an agent skill with the same name', () => {
    const winner = pickWinner([
      { name: 'memory-search', origin: 'agent' },
      { name: 'memory-search', origin: 'system' },
    ]);
    expect(winner?.origin).toBe('system');
  });

  it('picks the system winner over a user skill with the same name', () => {
    const winner = pickWinner([
      { name: 'self-config', origin: 'user' },
      { name: 'self-config', origin: 'system' },
    ]);
    expect(winner?.origin).toBe('system');
    expect(winner?.effectivePrecedence).toBe(6);
  });
});

describe('listSkillDTOs coverage (plan 435)', () => {
  let userDir: string;
  let projectDir: string;
  let customDir: string;
  let systemDir: string;

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-user-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-project-'));
    customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-custom-'));
    systemDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-system-'));
    fs.mkdirSync(path.join(systemDir, '.system'), { recursive: true });
  });

  afterEach(() => {
    for (const dir of [userDir, projectDir, customDir, systemDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists skills from user, project, custom, and system dirs', () => {
    writeSkill(userDir, 'user-skill', 'A user skill.');
    writeSkill(projectDir, 'project-skill', 'A project skill.');
    writeSkill(customDir, 'custom-skill', 'A custom-path skill.');
    writeSkill(path.join(systemDir, '.system'), 'memory-search', 'RAG memory search.');

    const skills: SkillListItem[] = listSkillDTOs({
      ...baseArgs(),
      userSkillsDir: userDir,
      projectSkillsDirs: [projectDir],
      customSkillDir: customDir,
      systemSkillsDir: path.join(systemDir, '.system'),
    });

    const byId = new Map(skills.map((s) => [s.id, s]));
    expect(byId.get('user:user-skill')?.source).toBe('user');
    expect(byId.get('project:project-skill')?.source).toBe('project');
    expect(byId.get('custom:custom-skill')?.source).toBe('custom');
    expect(byId.get('system:memory-search')?.source).toBe('system');
  });

  it('scans every project dir, including the cross-agent .agent/skills standard', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-agent-'));
    try {
      writeSkill(projectDir, 'project-skill', 'From .duya/skills.');
      writeSkill(agentDir, 'agent-skill', 'From .agent/skills.');

      const skills: SkillListItem[] = listSkillDTOs({
        ...baseArgs(),
        userSkillsDir: userDir,
        projectSkillsDirs: [agentDir, projectDir],
      });

      const byId = new Map(skills.map((s) => [s.id, s]));
      expect(byId.get('project:agent-skill')?.source).toBe('project');
      expect(byId.get('project:project-skill')?.source).toBe('project');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('lists bot-scoped skills as agent source and shadows same-named user skills', () => {
    const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-svc-bot-'));
    try {
      writeSkill(userDir, 'shared', 'Global user copy.');
      writeSkill(botDir, 'shared', 'Bot-scoped copy.');
      writeSkill(botDir, 'bot-only', 'Only this bot has it.');

      const skills = listSkillDTOs({
        ...baseArgs(),
        userSkillsDir: userDir,
        agentSkillsDir: botDir,
      });

      const byId = new Map(skills.map((s) => [s.id, s]));
      // Agent skill shadows the global user skill with the same name.
      expect(byId.get('agent:shared')?.source).toBe('agent');
      expect(byId.get('user:shared')).toBeUndefined();
      expect(byId.get('agent:bot-only')?.source).toBe('agent');
    } finally {
      fs.rmSync(botDir, { recursive: true, force: true });
    }
  });

  it('keeps system skills enabled regardless of overrides', () => {
    writeSkill(path.join(systemDir, '.system'), 'self-config', 'DUYA self-configuration.');

    const skills = listSkillDTOs({
      ...baseArgs({ 'system:self-config': false }),
      userSkillsDir: userDir,
      systemSkillsDir: path.join(systemDir, '.system'),
    });

    const system = skills.find((s) => s.id === 'system:self-config');
    expect(system?.enabled).toBe(true);
  });

  it('getSkillInfoDTO resolves a system skill by id', () => {
    writeSkill(path.join(systemDir, '.system'), 'self-knowledge', 'DUYA knowledge map.');

    const info = getSkillInfoDTO({
      ...baseArgs(),
      userSkillsDir: userDir,
      systemSkillsDir: path.join(systemDir, '.system'),
      id: 'system:self-knowledge',
    });

    expect(info?.name).toBe('self-knowledge');
    expect(info?.source).toBe('system');
    expect(info?.description).toContain('DUYA knowledge map');
    expect(info?.customized).toBe(false);
  });
});
