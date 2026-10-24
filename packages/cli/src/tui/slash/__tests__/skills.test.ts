/**
 * packages/cli/src/tui/slash/__tests__/skills.test.ts
 *
 * `/skills` — the skills of the current project, listed in the terminal.
 *
 * ## Why a REAL skills directory and not a mocked service
 *
 * The command's whole job is to find skills on disk: read the frontmatter,
 * decide which skill wins a name, report where each one came from. A mock of
 * `listSkillDTOs` would encode this file's own beliefs about those rules, so
 * a wrong belief would pass. Every case here therefore builds real skill
 * directories (`<dir>/<name>/SKILL.md`) in a temporary directory and lets the
 * Host's own service read them.
 *
 * Two things are pinned down so the cases stay hermetic:
 *
 *  1. The home directory, because the user skills live under `~/.duya/skills`.
 *     Without this the suite would read the developer's real skills and the
 *     "no skills" case would depend on the machine it runs on.
 *  2. The Duya data root, because the configured custom skills directory is
 *     read from `config.toml` there.
 *
 * The session's working directory comes from the Host's local session
 * projection, so the client is the only thing that is faked — the same shape
 * `/diff` uses.
 *
 * ## What these cases pin
 *
 *  1. A skill is listed with its source, its description and whether the user
 *     can invoke it — including a skill that says it cannot be.
 *  2. A project skill, a user skill, a system skill and a configured custom
 *     skill are all found, and each says where it came from.
 *  3. No skills is said plainly. An empty table would read as a broken one.
 *  4. A session without a working directory is refused, not answered from
 *     some other directory.
 *  5. The plugin limitation is stated, so a shorter list than the Desktop's
 *     is not read as a wrong list.
 *  6. The command works while a turn is streaming: it is a read.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { SKILLS_COMMANDS } from '../skills.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-skills-1';

const COMMAND = SKILLS_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the skills command is not exported');

/**
 * The home directory the command reads. A mutable box, because the mock
 * factory below is hoisted above every module-level binding.
 */
const osState = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => osState.home };
});

// ───────────────────────────── fixtures ─────────────────────────────

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  osState.home = '';
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort: a file handle may still be open on Windows.
    }
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'duya-cli-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A skill directory with a SKILL.md, the shape the loader reads. */
function writeSkill(skillsDir: string, name: string, frontmatter: readonly string[]): void {
  const directory = join(skillsDir, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\n${frontmatter.join('\n')}\n---\n\nThe body of the skill.\n`,
    'utf8',
  );
}

/** The user's Duya root for this case. */
function homeRoot(): string {
  const home = temporaryDirectory();
  osState.home = home;
  return home;
}

/** The Duya data root, which holds `config.toml`. */
function dataRoot(): string {
  const root = temporaryDirectory();
  vi.stubEnv('DUYA_DATA_ROOT', root);
  vi.stubEnv('DUYA_TEST', '');
  return root;
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly output: string;
}

/**
 * Run `/skills` against a client whose local session projection answers with
 * `workingDirectory` (or fails with `readError`).
 */
async function run(options: {
  readonly workingDirectory?: string | null;
  readonly readError?: Error;
  readonly overrides?: string | null;
  readonly busy?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const client = {
    readLocalSession: vi.fn(async () => {
      if (options.readError !== undefined) throw options.readError;
      if (options.workingDirectory === undefined || options.workingDirectory === null) return null;
      return { id: SESSION_ID, workingDirectory: options.workingDirectory };
    }),
    getSetting: vi.fn(async () => options.overrides ?? null),
  } as unknown as HostSessionHttpClient;
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
  };
  const ctx = {
    client,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');

  return { notices, errors, output: notices.join('\n') };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/skills', () => {
  it('lists a skill with its source, its description and whether it is invocable', async () => {
    const home = homeRoot();
    dataRoot();
    writeSkill(join(home, '.duya', 'skills'), 'demo-skill', [
      'name: demo-skill',
      'description: A demo skill',
    ]);
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+yes\s+A demo skill/);
  });

  it('says a skill that declares itself non-invocable is not invocable', async () => {
    const home = homeRoot();
    dataRoot();
    writeSkill(join(home, '.duya', 'skills'), 'internal-skill', [
      'name: internal-skill',
      'description: Internal helper',
      'user-invocable: false',
    ]);
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project });

    expect(errors).toEqual([]);
    expect(output).toMatch(/internal-skill\s+user\s+no\s+yes\s+Internal helper/);
  });

  it('finds the project, user, system and configured custom skills, each with its source', async () => {
    const home = homeRoot();
    const root = dataRoot();

    const project = temporaryDirectory();
    writeSkill(join(project, '.agent', 'skills'), 'project-skill', [
      'name: project-skill',
      'description: A project skill',
    ]);
    writeSkill(join(home, '.duya', 'skills'), 'user-skill', [
      'name: user-skill',
      'description: A user skill',
    ]);
    writeSkill(join(home, '.duya', 'skills', '.system'), 'system-skill', [
      'name: system-skill',
      'description: A system skill',
    ]);

    const custom = temporaryDirectory();
    writeSkill(custom, 'custom-skill', [
      'name: custom-skill',
      'description: A custom skill',
    ]);
    // A TOML LITERAL string: a basic string would read the Windows
    // backslashes as escapes.
    writeFileSync(join(root, 'config.toml'), `[agent]\nskill_path = '${custom}'\n`, 'utf8');

    const { output, errors } = await run({ workingDirectory: project });

    expect(errors).toEqual([]);
    expect(output).toMatch(/project-skill\s+project\s+yes\s+yes\s+A project skill/);
    expect(output).toMatch(/user-skill\s+user\s+yes\s+yes\s+A user skill/);
    expect(output).toMatch(/system-skill\s+system\s+yes\s+yes\s+A system skill/);
    expect(output).toMatch(/custom-skill\s+custom\s+yes\s+yes\s+A custom skill/);
  });

  it('marks a skill the user turned off as not enabled', async () => {
    const home = homeRoot();
    dataRoot();
    writeSkill(join(home, '.duya', 'skills'), 'demo-skill', [
      'name: demo-skill',
      'description: A demo skill',
    ]);
    const project = temporaryDirectory();

    const { output, errors } = await run({
      workingDirectory: project,
      overrides: JSON.stringify({ 'demo-skill': false }),
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+no\s+A demo skill/);
  });

  it('says plainly that there are no skills, and prints no table', async () => {
    homeRoot();
    dataRoot();
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project });

    expect(errors).toEqual([]);
    expect(output).toContain('no skills found');
    // An empty table reads as a broken table.
    expect(output).not.toContain('invocable');
  });

  it('states that plugin skills are not available to a standalone CLI', async () => {
    homeRoot();
    dataRoot();
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project });

    expect(errors).toEqual([]);
    expect(output).toContain('Plugin skills are not listed');
  });

  it('refuses when the session has no working directory', async () => {
    homeRoot();
    dataRoot();

    const { output, errors } = await run({ workingDirectory: '' });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('no working directory');
  });

  it('refuses when the Host cannot tell which project this is', async () => {
    homeRoot();
    dataRoot();
    const error = Object.assign(new Error('Duya Host request failed (404: local_session_projection_unavailable)'), {
      status: 404,
      code: 'local_session_projection_unavailable',
    });

    const { output, errors } = await run({ readError: error });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('does not expose the session');
  });

  it('refuses when the home directory is unknown, because the data root is not', async () => {
    osState.home = '';
    dataRoot();
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project });

    expect(output).toEqual('');
    expect(errors.join('\n')).toContain('home directory');
  });

  it('works while a turn is streaming, because a skill list is a read', async () => {
    const home = homeRoot();
    dataRoot();
    writeSkill(join(home, '.duya', 'skills'), 'demo-skill', [
      'name: demo-skill',
      'description: A demo skill',
    ]);
    const project = temporaryDirectory();

    const { output, errors } = await run({ workingDirectory: project, busy: true });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+yes\s+A demo skill/);
  });
});
