/**
 * packages/agent/tests/skills/agent-scoped.test.ts
 *
 * Bot-scoped skills: a bot's own skills directory
 * (`~/.duya/agents/<botId>/skills`) is loaded as source 'agent' and shadows
 * any same-named global user skill at runtime (the registry Map keeps the
 * last registration). System skills still win name collisions.
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

import {
  loadSkills,
  getAgentSkillDirectory,
} from '../../src/skills/loader.js';
import { getSkillRegistry, resetSkillRegistry } from '../../src/skills/registry.js';

function writeSkill(dir: string, name: string, body: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n\n${body}\n`,
    'utf-8',
  );
}

describe('bot-scoped (agent) skills', () => {
  let home: string;
  let userSkillsDir: string;
  let botId: string;
  let botSkillsDir: string;

  beforeEach(() => {
    resetSkillRegistry();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-home-'));
    (os.homedir as ReturnType<typeof vi.fn>).mockReturnValue(home);
    userSkillsDir = path.join(home, '.duya', 'skills');
    botId = 'my-bot';
    botSkillsDir = getAgentSkillDirectory(botId);
    fs.mkdirSync(path.join(userSkillsDir, 'shared-skill'), { recursive: true });
    fs.mkdirSync(path.join(botSkillsDir, 'shared-skill'), { recursive: true });
    fs.mkdirSync(path.join(botSkillsDir, 'bot-only-skill'), { recursive: true });
    // Vitest pool workers expose a process.send channel that is not the
    // agent IPC channel; disable it so the loader's db-client takes the
    // "not in agent mode" path (same as user-dir-system-skip.test.ts).
    (process as unknown as { send?: unknown }).send = undefined;
  });

  afterEach(() => {
    resetSkillRegistry();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('resolves the bot skills dir under ~/.duya/agents/<botId>/skills', () => {
    expect(botSkillsDir).toBe(path.join(home, '.duya', 'agents', 'my-bot', 'skills'));
  });

  it('loads bot skills with source agent and lets them shadow same-named user skills', async () => {
    writeSkill(userSkillsDir, 'shared-skill', 'Global user copy.');
    writeSkill(botSkillsDir, 'shared-skill', 'Bot-scoped copy.');
    writeSkill(botSkillsDir, 'bot-only-skill', 'Only this bot has it.');

    await loadSkills(home, {
      syncBundled: false,
      agentSkillsDir: botSkillsDir,
    });

    const registry = getSkillRegistry();
    // Same-named bot skill wins over the global user skill.
    expect(registry.get('shared-skill')?.source).toBe('agent');
    // Bot-only skill is present.
    expect(registry.get('bot-only-skill')?.source).toBe('agent');
  });

  it('still lets system skills win a name collision against a bot skill', async () => {
    // A bot skill named like a bundled system skill must not shadow it:
    // system skills are highest precedence and loaded last.
    writeSkill(botSkillsDir, 'self-config', 'Bot copy must not override system.');

    await loadSkills(home, {
      syncBundled: false,
      agentSkillsDir: botSkillsDir,
    });

    const registry = getSkillRegistry();
    const systemSkill = registry.get('self-config');
    expect(systemSkill?.source).toBe('system');
    expect(systemSkill?.source).not.toBe('agent');
  });
});