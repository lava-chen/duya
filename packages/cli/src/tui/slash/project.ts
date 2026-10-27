/**
 * packages/cli/src/tui/slash/project.ts
 *
 * `/project` — move this TUI to another project directory.
 *
 * The TUI has always worked in the directory it was launched from: that is
 * where its session was registered, where its runs say the work happens, and
 * where tab-completion looks for files. `/project` changes all three at once,
 * which only the chat loop can do — hence `actions.startSessionInDirectory`
 * rather than a PATCH on the session record. A session's workspace is what its
 * rollout, its permission cursor and the checkout fence are keyed on, so the
 * conversation you leave behind stays honest about where it happened, and
 * `/resume` is how you get back to it.
 *
 * What counts as a project here is derived, not registered: the directories
 * this Host already has sessions in, taken from the local session projection
 * (`/diff` reads the same rows for the same reason — the public record carries
 * no path). A folder that has never had a session is reachable by typing its
 * path, in the picker or as an argument.
 */

import { existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TuiSlashActions, TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';

/** Picking this row asks for a folder instead of switching to one. */
const ADD_ROW_VALUE = 'add-directory';

/**
 * How many session rows the listing reads. This is a picker, not an index:
 * past this many rows the oldest projects are simply not offered, and the
 * argument form still reaches them.
 */
const SCANNED_SESSIONS = 200;

/** One directory offered by `/project`, with what this Host knows about it. */
export interface ProjectEntry {
  readonly directory: string;
  readonly sessionCount: number;
  readonly lastUsedAt: number;
}

/** The row fields the grouping needs, kept structural so callers stay narrow. */
type SessionRow = {
  readonly workingDirectory: string;
  readonly recencyAt: number | null;
  readonly updatedAt: number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Case-insensitive on Windows only. The Host stores what it canonicalised, so
 * the same folder reaches the list as `E:\Projects\duya` and `e:\projects\duya`
 * when two writers disagreed about case — and one project shown twice is a
 * project the user cannot pick.
 */
function dedupeKey(directory: string): string {
  return process.platform === 'win32' ? directory.toLowerCase() : directory;
}

function sameDirectory(left: string, right: string): boolean {
  return dedupeKey(path.resolve(left)) === dedupeKey(path.resolve(right));
}

/** `~` and `~/…` expand; everything else is used as given. */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Group session rows by the directory they ran in, most recently used first.
 *
 * The sort key is `recencyAt` — the last time a turn actually started — and
 * not `updatedAt`, which renaming or archiving bumps. A project the user only
 * tidied up must not climb to the top of the picker.
 */
export function projectEntries(sessions: readonly SessionRow[]): ProjectEntry[] {
  const byKey = new Map<string, ProjectEntry>();
  for (const session of sessions) {
    const directory = session.workingDirectory.trim();
    if (directory === '') continue;
    const key = dedupeKey(directory);
    const usedAt = session.recencyAt ?? session.updatedAt;
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined
      ? { directory, sessionCount: 1, lastUsedAt: usedAt }
      : {
          directory: existing.directory,
          sessionCount: existing.sessionCount + 1,
          lastUsedAt: Math.max(existing.lastUsedAt, usedAt),
        });
  }
  return [...byKey.values()].sort((left, right) =>
    right.lastUsedAt - left.lastUsedAt || left.directory.localeCompare(right.directory));
}

/**
 * The directory the current session actually runs in.
 *
 * `ctx.session` is the public record and carries no path, so this is the local
 * projection — the same source `/diff` uses. null means the Host does not
 * expose it, which costs the picker its `(current)` marker and nothing else.
 */
async function currentDirectory(ctx: TuiSlashContext): Promise<string | null> {
  try {
    const row = await ctx.client.readLocalSession(ctx.session.id, { includeAllSessions: true });
    const directory = row?.workingDirectory?.trim() ?? '';
    return directory === '' ? null : directory;
  } catch {
    return null;
  }
}

/** Resolve, refuse and report a directory, then cross the session boundary. */
async function switchTo(
  ctx: TuiSlashContext,
  actions: TuiSlashActions,
  raw: string,
): Promise<void> {
  const directory = path.resolve(expandHome(raw));
  if (!existsSync(directory)) {
    ctx.tui.printError(`No such directory: ${directory}`);
    return;
  }
  if (!statSync(directory).isDirectory()) {
    ctx.tui.printError(`Not a directory: ${directory}`);
    return;
  }
  const here = await currentDirectory(ctx);
  if (here !== null && sameDirectory(here, directory)) {
    ctx.tui.printNotice(`Already working in ${here}.`);
    return;
  }
  try {
    await actions.startSessionInDirectory(directory);
  } catch (error) {
    // A path the Host will not take — not a directory it can read, a network
    // share that is down — is an ordinary user mistake, so it is the path that
    // is named back, not a stack.
    ctx.tui.printError(`Could not start a session in ${directory}: ${describeError(error)}`);
  }
}

/** What the picker shows when this host has no filterable list at all. */
function printEntries(ctx: TuiSlashContext, entries: readonly ProjectEntry[], here: string | null): void {
  ctx.tui.printNotice('Projects this Host has sessions in:');
  ctx.tui.printNotice('');
  for (const entry of entries) {
    const marker = here !== null && sameDirectory(here, entry.directory) ? '   (current)' : '';
    ctx.tui.printNotice(`  ${entry.sessionCount}  ${entry.directory}${marker}`);
  }
  if (entries.length === 0) ctx.tui.printNotice('  (none yet)');
  ctx.tui.printNotice('');
  ctx.tui.printNotice('Usage: /project <path>');
}

const PROJECT_COMMAND: TuiSlashCommandDef = {
  name: 'project',
  argsHint: '[path]',
  description: 'Switch the project directory new sessions run in',
  group: 'Session ops',
  async run(ctx, args): Promise<TuiSlashOutcome> {
    if (ctx.busy) {
      // The switch crosses a session boundary, and a running turn owns the
      // session until it settles: the worker is the one that writes the
      // user's message into it.
      ctx.tui.printError('Cannot switch project while a turn is running — press Esc first.');
      return { kind: 'handled' };
    }
    const actions = ctx.actions;
    if (actions === undefined) {
      // Asked before refusing to browse: a surface that cannot cross the
      // boundary should say so rather than render a picker where every row
      // ends in a dead end.
      ctx.tui.printError('This command needs the running chat loop and is unavailable here.');
      return { kind: 'handled' };
    }

    const typed = args.trim();
    if (typed !== '') {
      await switchTo(ctx, actions, typed);
      return { kind: 'handled' };
    }

    let entries: ProjectEntry[];
    try {
      const page = await ctx.client.listLocalSessions({
        limit: SCANNED_SESSIONS,
        includeArchived: false,
        includeDeleted: false,
      });
      entries = projectEntries(page.sessions);
    } catch (error) {
      // No local projection, so no list — but a typed path needs none of it.
      ctx.tui.printError(`Cannot list projects here: ${describeError(error)}`);
      ctx.tui.printNotice('Use /project <path> to switch to a directory directly.');
      return { kind: 'handled' };
    }

    const here = await currentDirectory(ctx);
    if (ctx.tui.chooseFiltered === undefined) {
      printEntries(ctx, entries, here);
      return { kind: 'handled' };
    }

    const picked = await ctx.tui.chooseFiltered(
      'Switch project',
      [
        ...entries.map((entry) => ({
          label: `${path.basename(entry.directory)}${
            here !== null && sameDirectory(here, entry.directory) ? '  (current)' : ''
          }`,
          value: entry.directory,
          description: `${entry.sessionCount} session${entry.sessionCount === 1 ? '' : 's'} · ${entry.directory}`,
        })),
        {
          label: 'Add a directory…',
          value: ADD_ROW_VALUE,
          description: 'A folder with no sessions on this Host yet',
        },
      ],
      { footer: 'type to filter · ↑↓ choose · Enter switch · Esc cancel' },
    );
    if (picked === null) return { kind: 'handled' };

    if (picked === ADD_ROW_VALUE) {
      const asked = await ctx.tui.promptText?.('Project directory', {
        placeholder: 'an absolute path, e.g. ~/code/my-app',
      });
      const raw = asked?.trim() ?? '';
      if (raw === '') {
        if (ctx.tui.promptText === undefined) {
          ctx.tui.printError('This host cannot ask for a path — use /project <path>.');
        }
        return { kind: 'handled' };
      }
      await switchTo(ctx, actions, raw);
      return { kind: 'handled' };
    }

    await switchTo(ctx, actions, picked);
    return { kind: 'handled' };
  },
};

export const PROJECT_COMMANDS: readonly TuiSlashCommandDef[] = [PROJECT_COMMAND];
