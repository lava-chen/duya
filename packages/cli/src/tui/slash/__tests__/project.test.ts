/**
 * `/project` — the picker, the argument form, the register form, and the refusals.
 *
 * The switch itself is the loop's (`actions.startSessionInDirectory`), so most
 * of these cases are about what the command decides BEFORE crossing that
 * boundary: which projects it offers, what it does with a typed path, what it
 * writes when it registers one, and when it says no. The loop side is covered
 * in `chat-tui-project-switch.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { HostSessionRecord } from '@duya/agent-protocol';
import type { HostProjectRecord } from '@duya/agent-protocol/projects';
import type { TuiChoice } from '../../TUIApp.js';
import type { TuiSlashActions, TuiSlashContext, TuiSlashHost } from '../types.js';
import {
  PROJECT_COMMANDS,
  expandHome,
  findByDirectory,
  projectRows,
  splitPathAndName,
} from '../project.js';

const COMMAND = PROJECT_COMMANDS[0];
if (COMMAND === undefined) throw new Error('project.ts exports no command');

/** One registered project, only as far as the picker reads it. */
function project(
  overrides: Partial<HostProjectRecord> & { readonly canonical_root: string },
): HostProjectRecord {
  return {
    project_id: 'project-1',
    name: '',
    description: null,
    paths: [{ path: overrides.canonical_root, description: null }],
    icon: null,
    color: null,
    created_at: 0,
    last_seen_at: 0,
    ...overrides,
  };
}

/**
 * Two directories that exist. The picker tests end in a real switch, and a
 * path the command will not stat is a path it refuses before it ever reaches
 * the loop — so an invented `/work/api` tests the refusal, not the pick.
 */
const FIRST = path.resolve(os.tmpdir());
const SECOND = path.resolve(os.homedir());

describe('projectRows', () => {
  it('leaves out the rows the catalog sync wrote — they have no name', () => {
    const entries = projectRows([
      project({ canonical_root: '/auto/one', name: '' }),
      project({ canonical_root: '/named/one', name: 'named', last_seen_at: 10 }),
    ]);
    expect(entries.map((entry) => entry.directory)).toEqual(['/named/one']);
  });

  it('orders by when the Host last saw the project, then by name', () => {
    const entries = projectRows([
      project({ project_id: 'a', canonical_root: '/old', name: 'old', last_seen_at: 100 }),
      project({ project_id: 'b', canonical_root: 'fresh', name: 'fresh', last_seen_at: 300 }),
      project({ project_id: 'c', canonical_root: 'same', name: 'bravo', last_seen_at: 300 }),
      project({ project_id: 'd', canonical_root: 'same2', name: 'alpha', last_seen_at: 300 }),
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(['alpha', 'bravo', 'fresh', 'old']);
  });

  it('skips rows with no root instead of offering an empty one', () => {
    expect(projectRows([project({ canonical_root: '   ', name: 'nameless' })])).toHaveLength(0);
  });

  it('counts the paths of a multi-root project', () => {
    const entries = projectRows([
      project({
        canonical_root: '/root',
        name: 'multi',
        paths: [{ path: '/root', description: null }, { path: '/extra', description: null }],
      }),
    ]);
    expect(entries[0]?.pathCount).toBe(2);
  });
});

describe('findByDirectory', () => {
  it('finds a project by its canonical root', () => {
    const found = findByDirectory([project({ canonical_root: '/root', name: 'one' })], '/root');
    expect(found?.name).toBe('one');
  });

  it('finds a project by one of its extra paths', () => {
    const found = findByDirectory(
      [project({ canonical_root: '/root', name: 'one', paths: [{ path: '/extra', description: null }] })],
      '/extra',
    );
    expect(found?.name).toBe('one');
  });

  it('answers null for a directory no project owns', () => {
    expect(findByDirectory([project({ canonical_root: '/root', name: 'one' })], '/other')).toBeNull();
  });

  it('collapses one Windows folder spelled two ways, and does not on a case-sensitive fs', () => {
    const found = findByDirectory(
      [project({ canonical_root: 'E:\\Projects\\duya', name: 'one' })],
      'e:\\projects\\DUYA',
    );
    expect(found === null).toBe(process.platform !== 'win32');
  });
});

describe('splitPathAndName', () => {
  it('takes one token as the path and leaves the name empty', () => {
    expect(splitPathAndName('/srv/app')).toEqual({ path: '/srv/app', name: '' });
  });

  it('takes the first token as the path and the rest as the name', () => {
    expect(splitPathAndName('/srv/app My App')).toEqual({ path: '/srv/app', name: 'My App' });
  });

  it('keeps a quoted path whole', () => {
    expect(splitPathAndName('"C:\\My Projects\\app"')).toEqual({
      path: 'C:\\My Projects\\app',
      name: '',
    });
  });

  it('keeps a quoted path whole and still takes the name after it', () => {
    expect(splitPathAndName('"C:\\My Projects\\app" codex')).toEqual({
      path: 'C:\\My Projects\\app',
      name: 'codex',
    });
  });
});

describe('expandHome', () => {
  it('expands ~ alone and ~/, and leaves anything else alone', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome(path.join('~', 'code'))).toBe(path.join(os.homedir(), 'code'));
    expect(expandHome('/srv/app')).toBe('/srv/app');
  });
});

function makeContext(options: {
  readonly projects?: readonly HostProjectRecord[];
  /** A different answer per call, for the paths that read the list twice. */
  readonly listProjectsImpl?: (call: number) => readonly HostProjectRecord[];
  readonly chooseResult?: (choices: readonly TuiChoice[]) => string | null;
  readonly promptResult?: string | null;
  readonly listThrows?: boolean;
  readonly createThrows?: Error;
  readonly currentDirectory?: string | null;
  readonly busy?: boolean;
  readonly actions?: TuiSlashActions | null;
  readonly chooseFiltered?: boolean;
} = {}) {
  const notices: string[] = [];
  const errors: string[] = [];
  const choicesSeen: TuiChoice[][] = [];
  const tui = {
    printNotice: (text: string) => { notices.push(text); },
    printError: (text: string) => { errors.push(text); },
    choose: async () => null,
    ...(options.chooseFiltered === false
      ? {}
      : {
        chooseFiltered: async (_title: string, choices: readonly TuiChoice[]) => {
          choicesSeen.push([...choices]);
          return options.chooseResult?.(choices) ?? null;
        },
      }),
    ...(options.promptResult === undefined
      ? {}
      : { promptText: async () => options.promptResult }),
  } as unknown as TuiSlashHost;

  let listCall = 0;
  const listProjects = vi.fn(async () => {
    if (options.listThrows === true) throw new Error('project_api_unavailable');
    listCall += 1;
    if (options.listProjectsImpl !== undefined) return options.listProjectsImpl(listCall);
    return options.projects ?? [];
  });
  const createProject = vi.fn(async () => {
    if (options.createThrows !== undefined) throw options.createThrows;
    return project({ canonical_root: FIRST, name: 'created' });
  });
  const updateProject = vi.fn(async () => project({ canonical_root: FIRST, name: 'updated' }));
  // Absent, present-but-blank, and present are three different Host answers,
  // and the command treats them differently.
  const readLocalSession = vi.fn(async () => {
    if (options.currentDirectory === undefined) throw new Error('local_session_projection_unavailable');
    return { workingDirectory: options.currentDirectory };
  });
  const client = {
    listProjects,
    createProject,
    updateProject,
    readLocalSession,
  } as unknown as HostSessionHttpClient;

  const startSessionInDirectory = vi.fn(async () => {});
  const actions: TuiSlashActions | undefined = options.actions === null
    ? undefined
    : options.actions ?? {
        interrupt: () => {},
        adoptSession: async () => {},
        startFreshSession: async () => {},
        startSessionInDirectory,
        reloadTranscript: async () => {},
      };

  const ctx = {
    client,
    session: { id: 'session-1' } as HostSessionRecord,
    tui,
    busy: options.busy ?? false,
    ...(actions === undefined ? {} : { actions }),
  } as TuiSlashContext;

  return {
    ctx,
    notices,
    errors,
    choicesSeen,
    listProjects,
    createProject,
    updateProject,
    startSessionInDirectory,
  };
}

describe('/project picker', () => {
  it('offers each registered project plus the register row, current one marked', async () => {
    const { ctx, choicesSeen, startSessionInDirectory } = makeContext({
      projects: [
        project({ project_id: 'a', canonical_root: FIRST, name: 'first', last_seen_at: 300 }),
        project({ project_id: 'b', canonical_root: SECOND, name: 'second', last_seen_at: 200 }),
      ],
      currentDirectory: FIRST,
      chooseResult: (choices) => choices[1]?.value ?? null,
    });
    await COMMAND.run(ctx, '');

    const choices = choicesSeen[0];
    expect(choices?.map((choice) => choice.value)).toEqual([FIRST, SECOND, 'add-directory']);
    expect(choices?.[0]?.label).toContain('(current)');
    expect(choices?.[0]?.label).toContain('first');
    expect(choices?.[1]?.description).toContain(SECOND);
    expect(startSessionInDirectory).toHaveBeenCalledWith(SECOND);
  });

  it('does not offer the rows no human registered', async () => {
    const { ctx, choicesSeen } = makeContext({
      projects: [project({ canonical_root: FIRST, name: '' })],
    });
    await COMMAND.run(ctx, '');
    expect(choicesSeen[0]?.map((choice) => choice.value)).toEqual(['add-directory']);
  });

  it('says so and stays put when the user cancels the list', async () => {
    const { ctx, startSessionInDirectory, notices } = makeContext({
      projects: [project({ canonical_root: FIRST, name: 'first' })],
    });
    await COMMAND.run(ctx, '');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('does not churn a session when the pick is the project already in', async () => {
    const { ctx, notices, startSessionInDirectory } = makeContext({
      projects: [project({ canonical_root: FIRST, name: 'first' })],
      currentDirectory: FIRST,
      chooseResult: (choices) => choices[0]?.value ?? null,
    });
    await COMMAND.run(ctx, '');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
    expect(notices.join('\n')).toContain('Already working in');
  });

  it('keeps the no-UI host useful by printing what it would have offered', async () => {
    const { ctx, notices, startSessionInDirectory } = makeContext({
      projects: [project({ canonical_root: FIRST, name: 'first' })],
      chooseFiltered: false,
    });
    await COMMAND.run(ctx, '');
    const printed = notices.join('\n');
    expect(printed).toContain('first');
    expect(printed).toContain(FIRST);
    expect(printed).toContain('/project add <path>');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('registers the directory typed into the register row', async () => {
    const { ctx, createProject, startSessionInDirectory } = makeContext({
      projects: [],
      chooseResult: (choices) => choices[choices.length - 1]?.value ?? null,
      promptResult: SECOND,
    });
    await COMMAND.run(ctx, '');
    expect(createProject).toHaveBeenCalledWith({
      name: path.basename(SECOND),
      paths: [{ path: SECOND, description: null }],
    });
    expect(startSessionInDirectory).toHaveBeenCalledWith(SECOND);
  });

  it('names the projection as the thing that failed, and keeps the typed path open', async () => {
    const { ctx, errors, notices } = makeContext({ listThrows: true });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('Cannot list projects here');
    expect(notices.join('\n')).toContain('/project <path>');
  });

  it('refuses mid-turn before reading anything, because a live run owns the session', async () => {
    const { ctx, errors, listProjects, startSessionInDirectory } = makeContext({ busy: true });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('while a turn is running');
    expect(listProjects).not.toHaveBeenCalled();
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('says what it needs when there is no loop to cross the boundary', async () => {
    const { ctx, errors } = makeContext({ actions: null, projects: [] });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('needs the running chat loop');
  });
});

describe('/project <path>', () => {
  it('switches to a directory given as an argument without listing', async () => {
    const target = path.resolve(os.tmpdir());
    const { ctx, startSessionInDirectory, listProjects } = makeContext();
    await COMMAND.run(ctx, target);
    expect(startSessionInDirectory).toHaveBeenCalledWith(target);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('refuses a path that is not there instead of starting a session in it', async () => {
    const missing = path.join(os.tmpdir(), 'duya-project-switch-no-such-dir');
    const { ctx, errors, startSessionInDirectory } = makeContext();
    await COMMAND.run(ctx, missing);
    expect(errors.join('\n')).toContain('No such directory');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('refuses a file', async () => {
    const file = path.join(process.cwd(), 'package.json');
    const { ctx, errors, startSessionInDirectory } = makeContext();
    await COMMAND.run(ctx, file);
    expect(errors.join('\n')).toContain('Not a directory');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('expands ~ the way a shell would', async () => {
    const { ctx, startSessionInDirectory } = makeContext();
    await COMMAND.run(ctx, '~');
    expect(startSessionInDirectory).toHaveBeenCalledWith(path.resolve(os.homedir()));
  });

  it('reports the Host refusing the directory rather than pretending it moved', async () => {
    const { ctx, errors } = makeContext({
      actions: {
        interrupt: () => {},
        adoptSession: async () => {},
        startFreshSession: async () => {},
        startSessionInDirectory: async () => { throw new Error('Directory must be an absolute, accessible local directory'); },
        reloadTranscript: async () => {},
      },
    });
    await COMMAND.run(ctx, path.resolve(os.tmpdir()));
    expect(errors.join('\n')).toContain('Could not start a session in');
    expect(errors.join('\n')).toContain('accessible local directory');
  });
});

describe('/project add <path>', () => {
  it('registers the directory under its own name and moves to it', async () => {
    const { ctx, createProject, startSessionInDirectory } = makeContext({ projects: [] });
    await COMMAND.run(ctx, `add ${FIRST}`);
    expect(createProject).toHaveBeenCalledWith({
      name: path.basename(FIRST),
      paths: [{ path: FIRST, description: null }],
    });
    expect(startSessionInDirectory).toHaveBeenCalledWith(FIRST);
  });

  it('registers it under the name the user gave', async () => {
    const { ctx, createProject } = makeContext({ projects: [] });
    await COMMAND.run(ctx, `add ${FIRST} codex`);
    expect(createProject).toHaveBeenCalledWith({
      name: 'codex',
      paths: [{ path: FIRST, description: null }],
    });
  });

  it('names the row that is already there instead of registering a second one', async () => {
    const { ctx, createProject, updateProject, startSessionInDirectory } = makeContext({
      projects: [project({ project_id: 'p1', canonical_root: FIRST, name: '' })],
    });
    await COMMAND.run(ctx, `add ${FIRST} codex`);
    expect(createProject).not.toHaveBeenCalled();
    expect(updateProject).toHaveBeenCalledWith('p1', { name: 'codex' });
    expect(startSessionInDirectory).toHaveBeenCalledWith(FIRST);
  });

  it('leaves a project that already carries the wanted name alone', async () => {
    const { ctx, createProject, updateProject, notices } = makeContext({
      projects: [project({ project_id: 'p1', canonical_root: FIRST, name: 'codex' })],
    });
    await COMMAND.run(ctx, `add ${FIRST} codex`);
    expect(createProject).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    expect(notices.join('\n')).toContain('already registered');
  });

  it('falls back to naming when another client registered the same root first', async () => {
    const conflict = Object.assign(new Error('A project already uses this canonical path'), {
      code: 'project_conflict',
    });
    const { ctx, createProject, updateProject } = makeContext({
      createThrows: conflict,
      listProjectsImpl: (call) => (call === 1
        ? []
        : [project({ project_id: 'raced', canonical_root: FIRST, name: '' })]),
    });
    await COMMAND.run(ctx, `add ${FIRST} codex`);
    expect(createProject).toHaveBeenCalled();
    expect(updateProject).toHaveBeenCalledWith('raced', { name: 'codex' });
  });

  it('reports a registration the Host refused, without moving', async () => {
    const { ctx, errors, startSessionInDirectory } = makeContext({
      projects: [],
      createThrows: new Error('project store is unavailable'),
    });
    await COMMAND.run(ctx, `add ${FIRST}`);
    expect(errors.join('\n')).toContain('Could not register');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('refuses a directory that is not there before writing anything', async () => {
    const missing = path.join(os.tmpdir(), 'duya-project-add-no-such-dir');
    const { ctx, errors, createProject, startSessionInDirectory } = makeContext({ projects: [] });
    await COMMAND.run(ctx, `add ${missing}`);
    expect(errors.join('\n')).toContain('No such directory');
    expect(createProject).not.toHaveBeenCalled();
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('says how to use it when the path is missing', async () => {
    const { ctx, errors, createProject } = makeContext({ projects: [] });
    await COMMAND.run(ctx, 'add');
    expect(errors.join('\n')).toContain('/project add <path>');
    expect(createProject).not.toHaveBeenCalled();
  });
});
