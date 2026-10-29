/**
 * packages/cli/src/tui/slash/project.ts
 *
 * `/project` — move this TUI to another project directory.
 *
 * A project here is the same thing the Desktop's project page calls a
 * project: a row in the Host's `projects` table. The TUI used to derive its
 * list from the sessions it could see, which made "project" mean "a directory
 * someone once ran a session in" — the throwaway worktrees, the scratch
 * folders and the half-typed paths all showed up, while the directory you
 * actually meant to go to (the one nobody had run in yet) never did. One
 * table, one meaning: the Desktop registers a project and the TUI sees it;
 * the TUI registers one and the Desktop sees it.
 *
 * The table also holds rows no human registered. The Desktop's catalog sync
 * writes one per session directory it has seen, with an empty name, so that
 * the memory layer can attribute a rollout to a project. Those rows are the
 * machine's bookkeeping, not the user's list of projects, so `/project`
 * leaves them out and `/project add` names one when the user means it.
 *
 * The switch itself is unchanged and still crosses a session boundary: the
 * TUI opens a new session in the target directory rather than re-binding the
 * current one, because a session's workspace is what its rollout, its
 * permission cursor and the checkout fence are keyed on. `/resume` is how
 * you get back to the old conversation.
 */

import { existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HostProjectRecord } from '@duya/agent-protocol/projects';
import type { TuiSlashActions, TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';

/** Picking this row asks for a directory to register instead of switching to one. */
const ADD_ROW_VALUE = 'add-directory';

/** One registered project, as the picker needs it. */
export interface ProjectEntry {
  readonly projectId: string;
  readonly name: string;
  /** The project's canonical root — where a session in this project starts. */
  readonly directory: string;
  /** How many paths the project carries; more than one means a multi-root project. */
  readonly pathCount: number;
  readonly lastUsedAt: number;
}

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
 * The registered projects, most recently used first.
 *
 * A row with no name was written by the Desktop's catalog sync, not by a
 * person, so it is not a project the user chose to work in — it is the
 * machine's record of where sessions happened. Naming it is what makes it a
 * project, and `/project add` is how that happens.
 *
 * The sort key is `last_seen_at` — the last time the Host saw this project —
 * and not `created_at`, so the project someone is working in today is the
 * one at the top.
 */
export function projectRows(records: readonly HostProjectRecord[]): ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  for (const record of records) {
    const name = record.name.trim();
    if (name === '') continue;
    const directory = record.canonical_root.trim();
    if (directory === '') continue;
    entries.push({
      projectId: record.project_id,
      name,
      directory,
      pathCount: record.paths.length,
      lastUsedAt: record.last_seen_at,
    });
  }
  return entries.sort(
    (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
  );
}

/**
 * The registered project that owns this directory, if any.
 *
 * `canonical_root` is UNIQUE but `paths` is not, so a project can carry a
 * directory that is not its root. Matching both is what keeps two projects
 * from claiming the same folder.
 */
export function findByDirectory(
  records: readonly HostProjectRecord[],
  directory: string,
): HostProjectRecord | null {
  for (const record of records) {
    if (record.canonical_root.trim() !== '' && sameDirectory(record.canonical_root, directory)) {
      return record;
    }
    if (record.paths.some((entry) => sameDirectory(entry.path, directory))) return record;
  }
  return null;
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

/** The name a project gets when the user does not give one. */
function defaultProjectName(directory: string): string {
  return path.basename(directory) || directory;
}

/**
 * Register a directory as a project, then move to it.
 *
 * A directory that already has a project row is not registered twice: the
 * existing row is named instead. That is the only way to promote one of the
 * catalog sync's unnamed rows — it is already there, and `canonical_root` is
 * UNIQUE, so a second row for the same folder cannot be created.
 */
async function registerProject(
  ctx: TuiSlashContext,
  actions: TuiSlashActions,
  raw: string,
  name: string,
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

  const wanted = name.trim() === '' ? defaultProjectName(directory) : name.trim();
  let records: readonly HostProjectRecord[];
  try {
    records = await ctx.client.listProjects();
  } catch (error) {
    ctx.tui.printError(`Cannot reach this Host's project list: ${describeError(error)}`);
    return;
  }

  const existing = findByDirectory(records, directory);
  if (existing !== null) {
    if (existing.name.trim() === wanted) {
      ctx.tui.printNotice(`${wanted} is already registered at ${existing.canonical_root}.`);
    } else {
      try {
        await ctx.client.updateProject(existing.project_id, { name: wanted });
        ctx.tui.printNotice(`Named ${existing.canonical_root} as ${wanted}.`);
      } catch (error) {
        ctx.tui.printError(`Could not name ${existing.canonical_root}: ${describeError(error)}`);
        return;
      }
    }
    await switchTo(ctx, actions, directory);
    return;
  }

  try {
    await ctx.client.createProject({
      name: wanted,
      paths: [{ path: directory, description: null }],
    });
    ctx.tui.printNotice(`Registered ${wanted} at ${directory}.`);
  } catch (error) {
    // Another client registered the same root between the read and the write.
    // The row exists either way, so name it and carry on.
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
    if (code !== 'project_conflict') {
      ctx.tui.printError(`Could not register ${directory}: ${describeError(error)}`);
      return;
    }
    try {
      const fresh = await ctx.client.listProjects();
      const raced = findByDirectory(fresh, directory);
      if (raced === null) {
        ctx.tui.printError(`Could not register ${directory}: ${describeError(error)}`);
        return;
      }
      await ctx.client.updateProject(raced.project_id, { name: wanted });
      ctx.tui.printNotice(`Named ${raced.canonical_root} as ${wanted}.`);
    } catch (retryError) {
      ctx.tui.printError(`Could not register ${directory}: ${describeError(retryError)}`);
      return;
    }
  }
  await switchTo(ctx, actions, directory);
}

/** What the picker shows when this host has no filterable list at all. */
function printEntries(ctx: TuiSlashContext, entries: readonly ProjectEntry[], here: string | null): void {
  ctx.tui.printNotice('Projects registered on this Host:');
  ctx.tui.printNotice('');
  for (const entry of entries) {
    const marker = here !== null && sameDirectory(here, entry.directory) ? '   (current)' : '';
    ctx.tui.printNotice(`  ${entry.name}  ${entry.directory}${marker}`);
  }
  if (entries.length === 0) {
    ctx.tui.printNotice('  (none yet — register one with /project add <path>)');
  }
  ctx.tui.printNotice('');
  ctx.tui.printNotice('Usage: /project <path> · /project add <path> [name]');
}

const PROJECT_COMMAND: TuiSlashCommandDef = {
  name: 'project',
  argsHint: '[add <path>] | [path]',
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
      const head = typed.split(/\s+/, 1)[0] ?? '';
      if (head.toLowerCase() === 'add') {
        const parts = splitPathAndName(typed.slice(head.length).trim());
        if (parts.path === '') {
          ctx.tui.printError('Usage: /project add <path> [name]');
          return { kind: 'handled' };
        }
        await registerProject(ctx, actions, parts.path, parts.name);
        return { kind: 'handled' };
      }
      await switchTo(ctx, actions, typed);
      return { kind: 'handled' };
    }

    let entries: ProjectEntry[];
    try {
      entries = projectRows(await ctx.client.listProjects());
    } catch (error) {
      // No project list, so no picker — but a typed path needs none of it.
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
          label: `${entry.name}${
            here !== null && sameDirectory(here, entry.directory) ? '  (current)' : ''
          }`,
          value: entry.directory,
          description: entry.pathCount > 1
            ? `${entry.directory} · ${entry.pathCount} paths`
            : entry.directory,
        })),
        {
          label: 'Register a directory…',
          value: ADD_ROW_VALUE,
          description: 'Add a folder to this Host as a project',
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
          ctx.tui.printError('This host cannot ask for a path — use /project add <path>.');
        }
        return { kind: 'handled' };
      }
      await registerProject(ctx, actions, raw, '');
      return { kind: 'handled' };
    }

    await switchTo(ctx, actions, picked);
    return { kind: 'handled' };
  },
};

/**
 * Split the argument of `/project add` into a path and an optional name.
 *
 * The path is the first whitespace-separated token and the name is the rest,
 * so a path with a space in it has to be quoted. The picker row does not have
 * this problem — it asks for the path in its own field.
 */
export function splitPathAndName(input: string): { readonly path: string; readonly name: string } {
  const quoted = /^"([^"]+)"(?:\s+(.*))?$/.exec(input);
  if (quoted !== null) {
    return { path: quoted[1] ?? '', name: (quoted[2] ?? '').trim() };
  }
  const tokens = input.split(/\s+/).filter((token) => token !== '');
  const first = tokens[0] ?? '';
  if (tokens.length <= 1) return { path: first, name: '' };
  return { path: first, name: tokens.slice(1).join(' ') };
}

export const PROJECT_COMMANDS: readonly TuiSlashCommandDef[] = [PROJECT_COMMAND];
