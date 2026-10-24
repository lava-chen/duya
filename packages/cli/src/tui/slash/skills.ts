/**
 * packages/cli/src/tui/slash/skills.ts
 *
 * `/skills` — the skills this project can use, listed in the terminal.
 *
 * ## The Host's skill service, in process
 *
 * The Desktop's `/skills` goes through the main process, which asks
 * `@duya/host/skills/skillService` for the winner set. The CLI has no main
 * process, but it does have `@duya/host` on its runtime dependencies and the
 * service is a pure filesystem read — so this command calls the SAME service
 * the Desktop calls. One service, two surfaces: the two lists cannot
 * disagree about which skill owns a name.
 *
 * ## The arguments, assembled the way the Desktop assembles them
 *
 * `apps/desktop/src/main/cli/handlers/skills.ts` builds the same
 * `SkillServiceListArgs` for its `/v1/skills` route. This file mirrors that
 * assembly and replaces the two Electron-only pieces with their standalone
 * equivalents:
 *
 * | argument | value | where it comes from |
 * | --- | --- | --- |
 * | `userSkillsDir` | `~/.duya/skills` | the home directory — the same path the agent's own loader reads (`getSkillDirectories` in `@duya/host/skills/loader`) |
 * | `projectSkillsDirs` | `<project>/.agent/skills`, `<project>/.duya/skills` | the SESSION's working directory |
 * | `systemSkillsDir` | `<userSkillsDir>/.system` | the synced copy of the bundled system skills, the same directory the Desktop reads |
 * | `customSkillDir` | `[agent] skill_path` | `config.toml` in the Duya data root — the Desktop reads the same key from its Electron config store |
 * | `pluginInstallPaths` | empty | see the limitation below |
 * | `overrides` | the `skillEnabledOverrides` setting | the Host's local settings, read through the client |
 *
 * ## The session's working directory, not `process.cwd()`
 *
 * Project skills live next to the project the session works in. `process.cwd()`
 * is wherever the user happened to start the CLI, which is a different fact
 * as soon as the session was resumed from another directory. So the path is
 * read from the local session projection — the same way `/diff` reads it. When
 * that projection cannot answer, this command refuses rather than listing
 * some other directory's skills.
 *
 * ## What a standalone CLI cannot see
 *
 * Plugin-declared skills are NOT in this list, and the list says so. The
 * plugin registry a Host knows about carries no `installPath`, and the plugin
 * packages themselves live under the Electron app's `userData` directory, so
 * a CLI that runs on its own has no directory to scan. `pluginInstallPaths`
 * therefore stays empty — the one argument this surface cannot fill.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from '@iarna/toml';
import { resolveDataRoot } from '@duya/data/data-paths';
import {
  getSkillInfoDTO,
  listSkillDTOs,
  type SkillServiceListArgs,
} from '@duya/host/skills/skillService';
import type { HostSessionHttpClient } from '@duya/host/http-client';

import { describeError, hostErrorCode, showPanel } from './shared.js';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';

/**
 * The settings key the Desktop's skill toggles write. The Desktop keeps it in
 * its Electron config store; the Host serves the same setting on its local
 * settings surface, which is where a CLI reads it from.
 */
const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';

/**
 * The one line that says what this surface cannot see.
 *
 * It is printed with EVERY answer, including the empty one: a list that is
 * shorter than the Desktop's without this sentence reads as a wrong list
 * rather than as a smaller surface.
 */
const PLUGIN_LIMITATION =
  'Plugin skills are not listed: the plugin registry carries no install path and the plugin packages '
  + 'live under the Electron app\'s data directory, so a standalone CLI cannot see them.';

/**
 * The session's working directory, as the Host recorded it.
 *
 * `ctx.session` is the public session record and carries no path, so the
 * local session projection is the only place the path still exists. A Host
 * without that projection cannot answer, and that is a different answer from
 * "this session has no working directory".
 */
async function sessionWorkingDirectory(
  ctx: TuiSlashContext,
): Promise<
  { readonly ok: true; readonly workingDirectory: string }
  | { readonly ok: false; readonly message: string }
> {
  let session: Awaited<ReturnType<HostSessionHttpClient['readLocalSession']>>;
  try {
    session = await ctx.client.readLocalSession(ctx.session.id, { includeAllSessions: true });
  } catch (error) {
    if (hostErrorCode(error) === 'local_session_projection_unavailable') {
      return {
        ok: false,
        message: 'This Host does not expose the session\'s working directory, so /skills cannot tell which project to list.',
      };
    }
    return {
      ok: false,
      message: `Could not read the session's working directory: ${describeError(error)}`,
    };
  }
  if (session === null) {
    return {
      ok: false,
      message: `Session ${ctx.session.id} is not on this Host, so there is no project to list skills for.`,
    };
  }
  const workingDirectory = typeof session.workingDirectory === 'string' ? session.workingDirectory : '';
  if (workingDirectory.trim() === '') {
    return {
      ok: false,
      message: 'This session has no working directory, so there is no project to list skills for.',
    };
  }
  return { ok: true, workingDirectory };
}

/**
 * The user's Duya root, or `undefined` when the home directory is unknown.
 *
 * The skills live under `~/.duya/skills` — the path the agent's own loader
 * reads — so an unknown home directory means an unknown skills directory. It
 * is NOT a reason to scan the current directory instead.
 */
function homeDirectory(): string | undefined {
  let home: string;
  try {
    home = homedir();
  } catch {
    return undefined;
  }
  return typeof home === 'string' && home.trim() !== '' ? home : undefined;
}

/**
 * The configured custom skills directory (`[agent] skill_path`).
 *
 * The Desktop reads this key from its Electron config store, which the CLI
 * cannot reach; the same value lives in `config.toml` in the Duya data root,
 * so the CLI reads it from there. A missing or malformed file means "no
 * custom directory", exactly like a store that has never been written.
 */
function customSkillDir(dataRoot: string): string | undefined {
  try {
    const configPath = join(dataRoot, 'config.toml');
    if (!existsSync(configPath)) return undefined;
    const parsed: unknown = parseToml(readFileSync(configPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const agent = (parsed as { readonly agent?: unknown }).agent;
    if (typeof agent !== 'object' || agent === null) return undefined;
    const value = (agent as { readonly skill_path?: unknown }).skill_path;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's per-skill enable/disable overrides.
 *
 * A Host that cannot answer the settings read still has skills; the
 * overrides are then simply unknown, and every skill reads as enabled. That
 * is the same fallback the Desktop's handler uses.
 */
async function readOverrides(ctx: TuiSlashContext): Promise<Record<string, boolean>> {
  try {
    const raw = await ctx.client.getSetting(SKILL_ENABLED_OVERRIDES_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
      ),
    );
  } catch {
    return {};
  }
}

/** One row of the printed list. */
interface SkillRow {
  readonly name: string;
  readonly source: string;
  readonly description: string;
  readonly userInvocable: boolean;
  readonly enabled: boolean;
}

/**
 * The list, as rows.
 *
 * `listSkillDTOs` decides which skill wins a name and what its id is; the
 * info DTO adds the user-invocable flag, which the list DTO does not carry.
 * The flag is read per skill, and each read re-walks the skill directories —
 * a handful of skills on a local disk, which is cheaper than a second
 * discovery implementation to keep in step.
 */
function skillRows(args: SkillServiceListArgs): SkillRow[] {
  return listSkillDTOs(args).map((item) => {
    const info = getSkillInfoDTO({ ...args, id: item.id });
    return {
      name: item.name,
      source: item.source,
      description: item.description,
      userInvocable: info?.userInvocable ?? true,
      enabled: item.enabled,
    };
  });
}

/** The table, aligned on the widest cell of each column. */
function renderTable(rows: readonly SkillRow[]): string[] {
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const sourceWidth = Math.max(...rows.map((row) => row.source.length));
  const header = `  ${'name'.padEnd(nameWidth)}  ${'source'.padEnd(sourceWidth)}  invocable  enabled  description`;
  const body = rows.map((row) => {
    const invocable = row.userInvocable ? 'yes' : 'no';
    const enabled = row.enabled ? 'yes' : 'no';
    return `  ${row.name.padEnd(nameWidth)}  ${row.source.padEnd(sourceWidth)}  ${invocable.padEnd(9)}  ${enabled.padEnd(7)}  ${row.description}`;
  });
  return [header, ...body];
}

const SKILLS_COMMAND: TuiSlashCommandDef = {
  name: 'skills',
  description: 'List available skills',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    const project = await sessionWorkingDirectory(ctx);
    if (!project.ok) {
      ctx.tui.printError(project.message);
      return { kind: 'handled' };
    }

    const home = homeDirectory();
    if (home === undefined) {
      ctx.tui.printError(
        'The home directory is unknown, so the Duya data root cannot be found and no skills can be listed.',
      );
      return { kind: 'handled' };
    }

    const userSkillsDir = join(home, '.duya', 'skills');
    const projectSkillsDirs = [
      join(project.workingDirectory, '.agent', 'skills'),
      join(project.workingDirectory, '.duya', 'skills'),
    ];
    const custom = customSkillDir(resolveDataRoot());

    const args: SkillServiceListArgs = {
      userSkillsDir,
      projectSkillsDirs,
      systemSkillsDir: join(userSkillsDir, '.system'),
      ...(custom === undefined ? {} : { customSkillDir: custom }),
      // A standalone CLI has no plugin registry to read install paths from;
      // see the limitation line printed below.
      pluginInstallPaths: {},
      overrides: await readOverrides(ctx),
    };

    let rows: SkillRow[];
    try {
      rows = skillRows(args);
    } catch (error) {
      ctx.tui.printError(`Could not read the skills: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const lines: string[] = [`project  ${project.workingDirectory}`, ''];
    if (rows.length === 0) {
      // No table: an empty table reads as a broken table.
      lines.push('  no skills found', '', '  searched');
      for (const directory of [userSkillsDir, ...projectSkillsDirs, ...(custom === undefined ? [] : [custom])]) {
        lines.push(`    ${directory}`);
      }
    } else {
      lines.push(...renderTable(rows));
    }
    lines.push('', PLUGIN_LIMITATION);

    showPanel(ctx, 'Skills', lines, { footer: 'Esc close', scrollable: true });
    return { kind: 'handled' };
  },
};

export const SKILLS_COMMANDS: readonly TuiSlashCommandDef[] = [SKILLS_COMMAND];
