/**
 * packages/cli/src/tui/slash/__tests__/skills.test.ts
 *
 * `/skills` — the skills of the current project, listed in the terminal.
 *
 * ## Where the discovery lives now
 *
 * The command used to scan the skill directories itself, inside the CLI
 * process. That discovery belongs to the Host now: the CLI asks
 * `GET /v1/skills` and prints the answer. The two suites therefore pin
 * DIFFERENT things:
 *
 *  - the Host's suite pins the DISCOVERY — which skill wins a name, where
 *    it came from, whether it is enabled;
 *  - this suite pins the PRESENTATION — that whatever the Host answered is
 *    shown as it was answered, that a refusal is not shown as an empty
 *    list, and that the one sentence about plugin skills is always there.
 *
 * A real skills directory here would test the Host's service from the
 * wrong side, so the cases below drive a stub client instead. What the
 * stub says IS what the Host would have said.
 *
 * ## What these cases pin
 *
 *  1. The command's identity: name, group, no aliases.
 *  2. The table: its columns, their order and their values.
 *  3. An empty inventory is said plainly, and no table is printed.
 *  4. "No skills" and "this Host cannot answer" are different facts and
 *     are rendered differently. A Host that answers 404
 *     `skill_inventory_unavailable` must NOT be shown an empty list: the
 *     question was never asked of an authority that could answer it.
 *  5. A session the Host does not have, and a transport failure, each
 *     report their own problem.
 *  6. The plugin limitation is on every panel.
 *  7. A read works while a turn is streaming.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { SKILLS_COMMANDS } from '../skills.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-skills-1';
const WORKING_DIRECTORY = '/work/project';

const COMMAND = SKILLS_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the skills command is not exported');

// ───────────────────────────── fixtures ─────────────────────────────

/** A Host HTTP error, shaped like the one the client throws. */
function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

/** One skill, as the Host's inventory route reports it. */
function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo-skill',
    name: 'demo-skill',
    description: 'A demo skill',
    source: 'user',
    enabled: true,
    userInvocable: true,
    ...overrides,
  };
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly panels: Array<{ title: string; lines: readonly string[] }>;
  /** Everything the command put on the screen, in one string. */
  readonly output: string;
  /** The stub's inventory read, for asserting how it was called. */
  readonly listSkills: ReturnType<typeof vi.fn> | undefined;
}

/**
 * Run `/skills` against a client whose inventory read answers with
 * `inventory` (or fails with `error`).
 */
async function run(options: {
  readonly inventory?: unknown;
  readonly error?: Error;
  readonly busy?: boolean;
  /** A client that has no inventory method at all. */
  readonly withoutMethod?: boolean;
  /** A host without a panel surface: the command must fall back to notices. */
  readonly withoutPanel?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const listSkills = options.withoutMethod === true
    ? undefined
    : vi.fn(async (_sessionId: string) => {
      if (options.error !== undefined) throw options.error;
      return options.inventory ?? { skills: [], workingDirectory: WORKING_DIRECTORY };
    });
  const client = listSkills === undefined ? {} : { listSkills };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    ...(options.withoutPanel === true
      ? {}
      : { showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); } }),
  };
  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');

  return {
    notices,
    errors,
    panels,
    listSkills,
    output: [
      ...notices,
      ...panels.flatMap((panel) => [panel.title, ...panel.lines]),
      ...errors,
    ].join('\n'),
  };
}

/** The inventory payload the stub answers with. */
function inventory(skills: readonly unknown[]): Record<string, unknown> {
  return { skills, workingDirectory: WORKING_DIRECTORY };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/skills', () => {
  it('is a session-info command named skills, with no aliases', () => {
    expect(COMMAND.name).toBe('skills');
    expect(COMMAND.aliases).toBeUndefined();
    expect(COMMAND.group).toBe('Session info');
    expect(COMMAND.description).toBe('List available skills');
  });

  it('lists every skill with its source, its description and whether it is invocable', async () => {
    const { output, errors } = await run({
      inventory: inventory([
        skill(),
        skill({
          id: 'project-skill',
          name: 'project-skill',
          description: 'A project skill',
          source: 'project',
        }),
      ]),
    });

    expect(errors).toEqual([]);
    // The columns, in order — a column that moved fails here.
    expect(output).toMatch(/name\s+source\s+invocable\s+enabled\s+description/);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+yes\s+A demo skill/);
    expect(output).toMatch(/project-skill\s+project\s+yes\s+yes\s+A project skill/);
  });

  it('asks the Host about the current session', async () => {
    const { listSkills } = await run({ inventory: inventory([skill()]) });

    expect(listSkills).toHaveBeenCalledWith(SESSION_ID);
  });

  it('says a skill the user cannot invoke is not invocable', async () => {
    const { output, errors } = await run({
      inventory: inventory([skill({ userInvocable: false })]),
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+no\s+yes\s+A demo skill/);
  });

  it('says a skill the user turned off is not enabled', async () => {
    const { output, errors } = await run({
      inventory: inventory([skill({ enabled: false })]),
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+no\s+A demo skill/);
  });

  it('prints the project the skills belong to', async () => {
    const { output, errors } = await run({ inventory: inventory([skill()]) });

    expect(errors).toEqual([]);
    expect(output).toMatch(/project\s+\/work\/project/);
  });

  it('says plainly that there are no skills, and prints no table', async () => {
    const { output, errors } = await run({ inventory: inventory([]) });

    expect(errors).toEqual([]);
    expect(output).toContain('no skills found');
    // An empty table reads as a broken table.
    expect(output).not.toContain('invocable');
  });

  it('states that plugin skills are not available to a standalone CLI', async () => {
    const { output, errors } = await run({ inventory: inventory([skill()]) });

    expect(errors).toEqual([]);
    expect(output).toContain('Plugin skills are not listed');
  });

  it('states the plugin limitation even when there are no skills', async () => {
    const { output, errors } = await run({ inventory: inventory([]) });

    expect(errors).toEqual([]);
    expect(output).toContain('Plugin skills are not listed');
  });

  it('says the Host cannot answer when the inventory is unavailable', async () => {
    const { output, errors, panels } = await run({
      error: hostError(404, 'skill_inventory_unavailable'),
    });

    // Not an empty list: the question was never asked of an authority
    // that could answer it.
    expect(output).not.toContain('no skills found');
    expect(output).toContain('does not serve the skills inventory');
    expect(output).toContain('skill_inventory_unavailable');
    expect(errors).toEqual([]);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe('Skills');
  });

  it('states the plugin limitation on the panel that says the Host cannot answer', async () => {
    const { output } = await run({ error: hostError(404, 'skill_inventory_unavailable') });

    expect(output).toContain('Plugin skills are not listed');
  });

  it('reports a session the Host does not have as a session problem', async () => {
    const { output, errors } = await run({ error: hostError(404, 'session_not_found') });

    expect(output).not.toContain('no skills found');
    expect(errors.join('\n')).toContain('not on this Host');
    expect(errors.join('\n')).toContain(SESSION_ID);
  });

  it('reports a transport failure as an error', async () => {
    const { output, errors, panels } = await run({
      error: new Error('connect ECONNREFUSED 127.0.0.1:4321'),
    });

    expect(errors.join('\n')).toContain('Could not read the skills inventory');
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    // No listing is shown for a read that failed.
    expect(panels).toEqual([]);
    expect(output).not.toContain('no skills found');
  });

  it('reports a payload that is not an inventory', async () => {
    const { errors, panels } = await run({ inventory: { unexpected: true } });

    expect(errors.join('\n')).toContain('not an inventory');
    expect(panels).toEqual([]);
  });

  it('skips a malformed entry instead of failing the whole listing', async () => {
    const { output, errors } = await run({
      inventory: inventory(['not-an-object', skill({ id: 'good', name: 'good' })]),
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/good\s+user\s+yes\s+yes\s+A demo skill/);
  });

  it('works while a turn is streaming, because a skill list is a read', async () => {
    const { output, errors } = await run({
      inventory: inventory([skill()]),
      busy: true,
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/demo-skill\s+user\s+yes\s+yes\s+A demo skill/);
  });

  it('falls back to plain notices when the host has no panel surface', async () => {
    const { notices, panels } = await run({
      inventory: inventory([skill()]),
      withoutPanel: true,
    });

    expect(panels).toEqual([]);
    expect(notices.join('\n')).toMatch(/demo-skill\s+user\s+yes\s+yes\s+A demo skill/);
  });

  it('says so when its own Host client has no inventory method', async () => {
    const { errors } = await run({ withoutMethod: true });

    expect(errors.join('\n')).toContain('cannot read the skills inventory');
  });
});
