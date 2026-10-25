/**
 * The skills inventory as a capability.
 *
 * What is under test is the PROJECTION: what the Host is willing to say
 * about the skills a session can use.
 *
 * The property that matters most here is that the SESSION decides the
 * project. Project skills live next to the project the session works in, so
 * a list built from `process.cwd()` would answer about the wrong directory —
 * and the wrong directory is the failure a client cannot detect. The
 * fixtures are therefore real directories on disk: a mocked skill service
 * would prove nothing about WHICH directories were read.
 *
 * The second property is ORDER. The list is sorted by code unit rather than
 * by locale, so "the skills, in order" is the same list on every machine —
 * a locale-aware sort would reorder the same configuration depending on who
 * asked.
 *
 * The third is the REFUSALS. "This Host cannot say which project" and "this
 * session is not here" are different answers, and so is "this Host has no
 * inventory capability at all" — none of them may be answered with an empty
 * list, which would say "this user has no skills" about a Host that simply
 * cannot tell.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostSkillInventoryApi,
  HostSkillInventoryError,
  type SkillInventorySources,
} from '../src/skills/skill-inventory-api.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface Fixture {
  /** The user's skills directory (`~/.duya/skills`). */
  readonly userSkillsDir: string;
  /** The Host's data root, where `config.toml` lives. */
  readonly dataRoot: string;
  /** The project the session works in. */
  readonly projectDir: string;
  /** A second project, for the sessions that work somewhere else. */
  readonly otherProjectDir: string;
  /** A plugin package directory, which this surface cannot reach. */
  readonly pluginDir: string;
}

/** A tree of real directories, with nothing in them yet. */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-skill-inventory-'));
  roots.push(root);
  const fixture: Fixture = {
    userSkillsDir: path.join(root, 'user-skills'),
    dataRoot: path.join(root, 'data'),
    projectDir: path.join(root, 'project'),
    otherProjectDir: path.join(root, 'other-project'),
    pluginDir: path.join(root, 'plugins', 'a-plugin', 'skills'),
  };
  for (const directory of [
    fixture.userSkillsDir,
    fixture.dataRoot,
    fixture.projectDir,
    fixture.otherProjectDir,
    fixture.pluginDir,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }
  return fixture;
}

/**
 * Write a skill directory: a directory named after the skill, holding a
 * SKILL.md with the given frontmatter.
 */
async function writeSkill(
  parent: string,
  name: string,
  frontmatter: Readonly<Record<string, string>> = {},
): Promise<void> {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: The ${name} skill`];
  for (const [key, value] of Object.entries(frontmatter)) lines.push(`${key}: ${value}`);
  lines.push('---', '', 'Body.');
  await fs.writeFile(path.join(directory, 'SKILL.md'), lines.join('\n'), 'utf8');
}

interface InventoryOptions {
  /** The working directory the known session works in; null = no such session. */
  readonly workingDirectory?: string | null;
  /** The user's per-skill enable overrides. */
  readonly overrides?: Record<string, boolean>;
  /** Whether the Host has a session projection at all. */
  readonly withSessions?: boolean;
}

/** An inventory over a fixture, with one session the Host knows. */
function inventoryFor(fixture: Fixture, options: InventoryOptions = {}) {
  const workingDirectory = options.workingDirectory === undefined
    ? fixture.projectDir
    : options.workingDirectory;
  const sources: SkillInventorySources = {
    userSkillsDir: fixture.userSkillsDir,
    dataRoot: fixture.dataRoot,
    ...(options.withSessions === false
      ? {}
      : {
        sessions: {
          async readWorkingDirectory(sessionId: string) {
            return sessionId === 'session-1' ? workingDirectory : null;
          },
        },
      }),
    settings: {
      async getSetting(key: string) {
        if (key !== 'skillEnabledOverrides') return null;
        return JSON.stringify(options.overrides ?? {});
      },
    },
  };
  return createHostSkillInventoryApi(sources);
}

describe('the skills inventory', () => {
  it('lists the skills the directories carry, and the project it listed them for', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.userSkillsDir, 'alpha');
    await writeSkill(path.join(fixture.projectDir, '.agent', 'skills'), 'beta');

    const result = await inventoryFor(fixture).listSkills({ sessionId: 'session-1' });

    expect(result.workingDirectory).toBe(fixture.projectDir);
    expect(result.skills).toEqual([
      {
        id: 'user:alpha',
        name: 'alpha',
        description: 'The alpha skill',
        source: 'user',
        enabled: true,
        userInvocable: true,
      },
      {
        id: 'project:beta',
        name: 'beta',
        description: 'The beta skill',
        source: 'project',
        enabled: true,
        userInvocable: true,
      },
    ]);
  });

  it('reads the project skills of the session\'s own directory', async () => {
    const fixture = await makeFixture();
    await writeSkill(path.join(fixture.projectDir, '.agent', 'skills'), 'here');
    await writeSkill(path.join(fixture.otherProjectDir, '.agent', 'skills'), 'elsewhere');

    const api = inventoryFor(fixture, { workingDirectory: fixture.otherProjectDir });

    const result = await api.listSkills({ sessionId: 'session-1' });

    expect(result.workingDirectory).toBe(fixture.otherProjectDir);
    expect(result.skills.map((skill) => skill.name)).toEqual(['elsewhere']);
  });

  it('reads the system skills and the custom skills directory', async () => {
    const fixture = await makeFixture();
    await writeSkill(path.join(fixture.userSkillsDir, '.system'), 'system-skill');
    const customDir = path.join(fixture.dataRoot, 'custom-skills');
    await writeSkill(customDir, 'custom-skill');
    await fs.writeFile(
      path.join(fixture.dataRoot, 'config.toml'),
      // A TOML literal string: a Windows path carries backslashes, and a
      // basic string would read them as escapes.
      `[agent]\nskill_path = '${customDir.replace(/\\/g, '/')}'\n`,
      'utf8',
    );

    const result = await inventoryFor(fixture).listSkills({ sessionId: 'session-1' });

    expect(result.skills.find((skill) => skill.name === 'system-skill')).toMatchObject({
      source: 'system',
    });
    expect(result.skills.find((skill) => skill.name === 'custom-skill')).toMatchObject({
      source: 'custom',
    });
  });

  it('reports a skill the user switched off as disabled', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.userSkillsDir, 'alpha');
    await writeSkill(fixture.userSkillsDir, 'beta');

    const api = inventoryFor(fixture, { overrides: { alpha: false } });

    const result = await api.listSkills({ sessionId: 'session-1' });

    expect(result.skills.find((skill) => skill.name === 'alpha')?.enabled).toBe(false);
    expect(result.skills.find((skill) => skill.name === 'beta')?.enabled).toBe(true);
  });

  it('reports a skill the frontmatter forbids the user from invoking', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.userSkillsDir, 'quiet', { 'user-invocable': 'false' });

    const result = await inventoryFor(fixture).listSkills({ sessionId: 'session-1' });

    expect(result.skills[0]).toMatchObject({ name: 'quiet', userInvocable: false });
  });

  it('orders the skills by code unit, not by locale', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.userSkillsDir, 'alpha');
    await writeSkill(fixture.userSkillsDir, 'Zeta');
    await writeSkill(fixture.userSkillsDir, 'Beta');

    const names = (await inventoryFor(fixture).listSkills({ sessionId: 'session-1' }))
      .skills.map((skill) => skill.name);

    // Code units: 'B' (66) < 'Z' (90) < 'a' (97). A locale-aware sort would
    // put 'alpha' first, so this assertion fails if `localeCompare` creeps in.
    expect(names).toEqual(['Beta', 'Zeta', 'alpha']);
    expect(names).not.toEqual(['alpha', 'Beta', 'Zeta']);
  });

  it('refuses a session this Host does not know', async () => {
    const fixture = await makeFixture();

    await expect(
      inventoryFor(fixture, { workingDirectory: null }).listSkills({ sessionId: 'session-1' }),
    ).rejects.toMatchObject({
      name: 'HostSkillInventoryError',
      code: 'session_not_found',
      status: 404,
    });
  });

  it('refuses when the Host has no session projection at all', async () => {
    const fixture = await makeFixture();

    // "This Host cannot say which project" and "this session is not here"
    // are different answers, and both are different from an empty list.
    await expect(
      inventoryFor(fixture, { withSessions: false }).listSkills({ sessionId: 'session-1' }),
    ).rejects.toMatchObject({
      name: 'HostSkillInventoryError',
      code: 'local_session_projection_unavailable',
      status: 404,
    });
  });

  it('lists no plugin skill, because this surface cannot reach the plugin packages', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.pluginDir, 'plugin-skill');

    const result = await inventoryFor(fixture).listSkills({ sessionId: 'session-1' });

    // The plugin registry a Host knows about carries no install path, and the
    // plugin packages live under the Electron app's data directory. So the
    // list is SHORTER than the Desktop's, and saying so is the honest answer
    // — a plugin skill that never appears is the known boundary of this
    // route, not a skill the agent cannot load.
    expect(result.skills.map((skill) => skill.name)).not.toContain('plugin-skill');
  });

  it('lists the user skills of a session with no working directory, and no project skills', async () => {
    const fixture = await makeFixture();
    await writeSkill(fixture.userSkillsDir, 'alpha');
    await writeSkill(path.join(fixture.projectDir, '.agent', 'skills'), 'beta');

    const result = await inventoryFor(fixture, { workingDirectory: '' })
      .listSkills({ sessionId: 'session-1' });

    // A session without a project still has the user's own skills, and the
    // answer says the project is empty rather than pointing at a relative
    // path that would scan whatever directory the Host happens to sit in.
    expect(result.workingDirectory).toBe('');
    expect(result.skills.map((skill) => skill.name)).toEqual(['alpha']);
  });

  it('throws a typed refusal, so the transport can name the reason', async () => {
    const fixture = await makeFixture();

    const error = await inventoryFor(fixture, { workingDirectory: null })
      .listSkills({ sessionId: 'session-1' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HostSkillInventoryError);
  });
});
