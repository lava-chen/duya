/**
 * `/project` — the picker, the argument form, and the refusals.
 *
 * The switch itself is the loop's (`actions.startSessionInDirectory`), so most
 * of these cases are about what the command decides BEFORE crossing that
 * boundary: which directories it offers, what it does with a typed path, and
 * when it says no. The loop side is covered in `chat-tui-project-switch.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostSessionHttpClient } from '@duya/host/http-client';
import type { HostSessionRecord } from '@duya/agent-protocol';
import type { TuiChoice } from '../../TUIApp.js';
import type { TuiSlashActions, TuiSlashContext, TuiSlashHost } from '../types.js';
import { PROJECT_COMMANDS, expandHome, projectEntries } from '../project.js';

const COMMAND = PROJECT_COMMANDS[0];
if (COMMAND === undefined) throw new Error('project.ts exports no command');

/** One session row, only as far as the grouping reads it. */
function row(workingDirectory: string, recencyAt: number | null = null): object {
  return { workingDirectory, recencyAt, updatedAt: recencyAt ?? 0 };
}

/**
 * Two directories that exist. The picker tests end in a real switch, and a
 * path the command will not stat is a path it refuses before it ever reaches
 * the loop — so an invented `/work/api` tests the refusal, not the pick.
 */
const FIRST = path.resolve(os.tmpdir());
const SECOND = path.resolve(os.homedir());

describe('projectEntries grouping', () => {
  it('counts the sessions of one directory and orders by last use', () => {
    const entries = projectEntries([
      row('/old/project', 100),
      row('/fresh/project', 300),
      row('/old/project', 200),
    ]);
    expect(entries.map((entry) => entry.directory)).toEqual(['/fresh/project', '/old/project']);
    expect(entries[1]?.sessionCount).toBe(2);
  });

  it('sorts by recency, not by the row count that would bury a busy old project', () => {
    const entries = projectEntries([
      row('/quiet/new', 500),
      row('/loud/old', 400),
      row('/loud/old', 300),
      row('/loud/old', 200),
    ]);
    expect(entries.map((entry) => entry.directory)).toEqual(['/quiet/new', '/loud/old']);
  });

  it('skips rows with no directory instead of offering an empty one', () => {
    expect(projectEntries([row('   '), row('/real', 1)])).toHaveLength(1);
  });

  it('uses updatedAt when a session was never turned into', () => {
    const entries = projectEntries([{ workingDirectory: '/a', recencyAt: null, updatedAt: 42 }]);
    expect(entries[0]?.lastUsedAt).toBe(42);
  });

  it('collapses one Windows folder spelled two ways, and does not on a case-sensitive fs', () => {
    const entries = projectEntries([row('E:\\Projects\\duya', 2), row('e:\\projects\\DUYA', 1)]);
    expect(entries).toHaveLength(process.platform === 'win32' ? 1 : 2);
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
  readonly rows?: readonly object[];
  readonly chooseResult?: (choices: readonly TuiChoice[]) => string | null;
  readonly promptResult?: string | null;
  readonly listThrows?: boolean;
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

  const listLocalSessions = vi.fn(async () => {
    if (options.listThrows === true) throw new Error('local_session_projection_unavailable');
    return { sessions: options.rows ?? [], nextCursor: null };
  });
  // Absent, present-but-blank, and present are three different Host answers,
  // and the command treats them differently.
  const readLocalSession = vi.fn(async () => {
    if (options.currentDirectory === undefined) throw new Error('local_session_projection_unavailable');
    return { workingDirectory: options.currentDirectory };
  });
  const client = {
    listLocalSessions,
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

  return { ctx, notices, errors, choicesSeen, listLocalSessions, startSessionInDirectory };
}

describe('/project picker', () => {
  it('offers each known directory plus the add row, current one marked', async () => {
    const { ctx, choicesSeen, startSessionInDirectory } = makeContext({
      rows: [row(FIRST, 300), row(SECOND, 200)],
      currentDirectory: FIRST,
      chooseResult: (choices) => choices[1]?.value ?? null,
    });
    await COMMAND.run(ctx, '');

    const choices = choicesSeen[0];
    expect(choices?.map((choice) => choice.value)).toEqual([FIRST, SECOND, 'add-directory']);
    expect(choices?.[0]?.label).toContain('(current)');
    expect(choices?.[1]?.description).toContain(SECOND);
    expect(startSessionInDirectory).toHaveBeenCalledWith(SECOND);
  });

  it('says so and stays put when the user cancels the list', async () => {
    const { ctx, startSessionInDirectory, notices } = makeContext({ rows: [row(FIRST, 1)] });
    await COMMAND.run(ctx, '');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('does not churn a session when the pick is the directory already in', async () => {
    const { ctx, notices, startSessionInDirectory } = makeContext({
      rows: [row(FIRST, 1)],
      currentDirectory: FIRST,
      chooseResult: (choices) => choices[0]?.value ?? null,
    });
    await COMMAND.run(ctx, '');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
    expect(notices.join('\n')).toContain('Already working in');
  });

  it('keeps the no-UI host useful by printing what it would have offered', async () => {
    const { ctx, notices, startSessionInDirectory } = makeContext({
      rows: [row(FIRST, 1)],
      chooseFiltered: false,
    });
    await COMMAND.run(ctx, '');
    const printed = notices.join('\n');
    expect(printed).toContain(FIRST);
    expect(printed).toContain('Usage: /project <path>');
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('takes a directory typed into the add row', async () => {
    const { ctx, startSessionInDirectory } = makeContext({
      rows: [row(FIRST, 1)],
      chooseResult: (choices) => choices[choices.length - 1]?.value ?? null,
      promptResult: SECOND,
    });
    await COMMAND.run(ctx, '');
    expect(startSessionInDirectory).toHaveBeenCalledWith(SECOND);
  });

  it('names the projection as the thing that failed, and keeps the typed path open', async () => {
    const { ctx, errors, notices } = makeContext({ listThrows: true });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('Cannot list projects here');
    expect(notices.join('\n')).toContain('/project <path>');
  });

  it('refuses mid-turn before reading anything, because a live run owns the session', async () => {
    const { ctx, errors, listLocalSessions, startSessionInDirectory } = makeContext({ busy: true });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('while a turn is running');
    expect(listLocalSessions).not.toHaveBeenCalled();
    expect(startSessionInDirectory).not.toHaveBeenCalled();
  });

  it('says what it needs when there is no loop to cross the boundary', async () => {
    const { ctx, errors } = makeContext({ actions: null, rows: [row('/work/api', 1)] });
    await COMMAND.run(ctx, '');
    expect(errors.join('\n')).toContain('needs the running chat loop');
  });
});

describe('/project <path>', () => {
  it('switches to a directory given as an argument without listing', async () => {
    const target = path.resolve(os.tmpdir());
    const { ctx, startSessionInDirectory, listLocalSessions } = makeContext();
    await COMMAND.run(ctx, target);
    expect(startSessionInDirectory).toHaveBeenCalledWith(target);
    expect(listLocalSessions).not.toHaveBeenCalled();
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
