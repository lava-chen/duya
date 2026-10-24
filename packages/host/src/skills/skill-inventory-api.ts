/**
 * The Host's read-only inventory of the skills a session can use.
 *
 * ## Why the Host owns this
 *
 * Skill discovery reads the filesystem and decides which skill wins a name.
 * That code reaches `@duya/agent-core`, and a CLIENT entry point is not
 * allowed to reach it — the `architecture:client-closure` gate stops a CLI
 * that imports the discovery service in process. So a client that can only
 * speak HTTP asks the Host, and the Host answers from the SAME service the
 * Desktop's own `/skills` uses: one discovery implementation, so the two
 * lists cannot disagree about who owns a name.
 *
 * ## The session's working directory, not `process.cwd()`
 *
 * Project skills live next to the project the session works in.
 * `process.cwd()` is wherever the Host happened to start, which is a
 * different fact as soon as the session was resumed from another directory.
 * The path comes from the local session projection, and a Host that cannot
 * answer that refuses rather than listing some other directory's skills.
 *
 * ## What this surface cannot see
 *
 * Plugin-declared skills are NOT in this list. The plugin registry a Host
 * knows about carries no install path — the plugin packages themselves live
 * under the Electron app's `userData` directory — so `pluginInstallPaths`
 * stays empty. That is the known boundary of this route, not a gap to be
 * closed by guessing a directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import type { HostSkillEntry, HostSkillInventoryApiV1 } from '@duya/agent-protocol';
import { getSkillInfoDTO, listSkillDTOs, type SkillServiceListArgs } from './skillService.js';

/**
 * The settings key the skill toggles write.
 *
 * The same key the Desktop's own toggles write, so the two surfaces read one
 * set of overrides instead of two that can drift.
 */
const SKILL_ENABLED_OVERRIDES_KEY = 'skillEnabledOverrides';

/**
 * Where the inventory reads the session's working directory from.
 *
 * A port rather than a direct call so the inventory can be exercised without
 * a session store, and so the Host can decide WHICH projection is
 * authoritative.
 */
export interface SkillInventorySessionSource {
  /**
   * The session's working directory, or `null` when this Host does not know
   * the session.
   */
  readWorkingDirectory(sessionId: string): Promise<string | null>;
}

/**
 * The local settings the inventory reads.
 */
export interface SkillInventorySettingsSource {
  getSetting(key: string): Promise<string | null>;
}

/**
 * Everything the inventory reads, as ports.
 */
export interface SkillInventorySources {
  /** The user's skills directory (`~/.duya/skills`). */
  readonly userSkillsDir: string;
  /** The Duya data root, where `config.toml` lives. */
  readonly dataRoot: string;
  /** The session projection. Absent when this Host exposes no session paths. */
  readonly sessions?: SkillInventorySessionSource;
  /** The local settings. Absent when this Host keeps no settings. */
  readonly settings?: SkillInventorySettingsSource;
}

export type HostSkillInventoryErrorCode =
  | 'local_session_projection_unavailable'
  | 'session_not_found';

/**
 * A refusal the HTTP layer can render without guessing a status.
 *
 * "This Host cannot say which project" and "this session is not here" are
 * different problems, and a 500 for either would be a lie about what the
 * Host knows.
 */
export class HostSkillInventoryError extends Error {
  readonly code: HostSkillInventoryErrorCode;
  readonly status: number;

  constructor(code: HostSkillInventoryErrorCode, message: string, status = 404) {
    super(message);
    this.name = 'HostSkillInventoryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Order two names by code unit.
 *
 * NOT `localeCompare`: that consults the machine's locale, so the same
 * configuration would come back in a different order on two machines, and
 * "the list is sorted" would stop being a property a client can rely on.
 */
function compareByCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The configured custom skills directory (`[agent] skill_path`).
 *
 * Read out of the Host's own `config.toml`. A missing file, a malformed file
 * and a missing key all mean the same thing — "no custom directory" — which
 * is also what a store that has never been written says.
 */
function readCustomSkillDir(dataRoot: string): string | undefined {
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
 * overrides are then simply unknown, and every skill reads as enabled.
 */
async function readOverrides(
  settings: SkillInventorySettingsSource | undefined,
): Promise<Record<string, boolean>> {
  if (!settings) return {};
  try {
    const raw = await settings.getSetting(SKILL_ENABLED_OVERRIDES_KEY);
    if (raw === null) return {};
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

/**
 * The session's working directory.
 *
 * The one thing the inventory cannot do without: the project's skills live
 * under it, so a Host that cannot name the project cannot answer.
 */
async function resolveWorkingDirectory(
  sources: SkillInventorySources,
  sessionId: string,
): Promise<string> {
  const sessions = sources.sessions;
  if (!sessions) {
    throw new HostSkillInventoryError(
      'local_session_projection_unavailable',
      'This Host does not expose the session working directory, so it cannot say which project to list skills for.',
    );
  }
  const workingDirectory = await sessions.readWorkingDirectory(sessionId);
  if (workingDirectory === null) {
    throw new HostSkillInventoryError('session_not_found', `Session not found: ${sessionId}`);
  }
  return workingDirectory;
}

/**
 * The directories the skills are read from.
 *
 * The same set the agent's own loader reads, so the list a client sees is
 * the list the agent would load.
 */
function buildArgs(
  sources: SkillInventorySources,
  workingDirectory: string,
  overrides: Record<string, boolean>,
): SkillServiceListArgs {
  const customSkillDir = readCustomSkillDir(sources.dataRoot);
  // A session without a working directory has no project, and a relative
  // path here would scan the Host's own current directory by accident.
  const projectRoot = workingDirectory.trim() === '' ? undefined : workingDirectory;
  return {
    userSkillsDir: sources.userSkillsDir,
    ...(projectRoot === undefined
      ? {}
      : {
        projectSkillsDirs: [
          join(projectRoot, '.agent', 'skills'),
          join(projectRoot, '.duya', 'skills'),
        ],
      }),
    // The synced copy of the bundled system skills.
    systemSkillsDir: join(sources.userSkillsDir, '.system'),
    ...(customSkillDir === undefined ? {} : { customSkillDir }),
    // Plugin skills are out of reach on this surface: the plugin registry
    // carries no install path, and the plugin packages live under the
    // Electron app's data directory.
    pluginInstallPaths: {},
    overrides,
  };
}

/**
 * Build the inventory capability over its sources.
 */
export function createHostSkillInventoryApi(sources: SkillInventorySources): HostSkillInventoryApiV1 {
  return {
    async listSkills(input) {
      const workingDirectory = await resolveWorkingDirectory(sources, input.sessionId);
      const args = buildArgs(sources, workingDirectory, await readOverrides(sources.settings));
      const skills = listSkillDTOs(args).map((item) => {
        // The list DTO does not carry the user-invocable flag; the info DTO
        // does, and reading it costs one more walk of the skill directories
        // per skill. A handful of skills on a local disk is cheaper than a
        // second discovery implementation to keep in step.
        const info = getSkillInfoDTO({ ...args, id: item.id });
        const entry: HostSkillEntry = {
          id: item.id,
          name: item.name,
          description: item.description,
          source: item.source,
          enabled: item.enabled,
          userInvocable: info?.userInvocable ?? true,
        };
        return entry;
      });
      skills.sort((left, right) => compareByCodeUnit(left.name, right.name));
      return { skills, workingDirectory };
    },
  };
}
