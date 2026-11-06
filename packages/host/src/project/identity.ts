/**
 * identity.ts — the Project Coordinator's product identity.
 *
 * The Coordinator runs on the shared Session runtime, but these values are
 * product decisions rather than runtime mechanics. They live here so the
 * generic Session service never has to recognise a Coordinator by a string
 * literal, and so the agent profile, the dispatch port and the prompt system
 * agree on one definition.
 */

export const PROJECT_COORDINATOR_PROFILE_ID = 'project-coordinator';

/** Work Sessions execute as a real work role, never as the Coordinator. */
export const PROJECT_WORK_SESSION_PROFILE_ID = 'code-expert';

/**
 * Management-only allowlist: no filesystem, shell, browser or device tools.
 *
 * The Session tools are named individually, by their REGISTERED names. The
 * Coordinator needs to spawn, inspect, steer, and cancel the work Sessions
 * bound to its project (project-coordinator-contract.md §2), and the prompt
 * templates tell it to reach them by those names. A single `session` entry
 * matched nothing once #579 moved the Session tools into the `duya_app` MCP
 * and split the one tool into per-action ones — the literal outlived the
 * rename, and the Coordinator silently lost its whole Session surface.
 *
 * The names are exact rather than a `session*` wildcard for two reasons:
 * `isToolVisible` promotes a deferred tool only on an EXACT allowlist hit
 * (agent-runtime/authorization/tool-filter.ts), so a wildcard would leave
 * these behind a catalog lookup; and the contract explicitly declines to
 * grant every Session tool #579 registered (`session_fork` and
 * `session_search` are reusable but stay out of the Coordinator's hand).
 */
export const PROJECT_COORDINATOR_ALLOWED_TOOLS = [
  'session_spawn',
  'session_get',
  'session_reply',
  'session_read',
  'session_rename',
  'session_list',
  'session_send',
  'session_status',
  'session_cancel',
  'session_control',
  'project',
  'todo',
] as const;

export const PROJECT_TASK_SUBJECT_MAX_LENGTH = 160;
export const PROJECT_TASK_DESCRIPTION_MAX_LENGTH = 12_000;

export function isProjectCoordinatorProfile(
  profileId: string | null | undefined,
): boolean {
  return profileId === PROJECT_COORDINATOR_PROFILE_ID;
}
